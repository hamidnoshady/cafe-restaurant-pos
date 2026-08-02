/**
 * Phase 20 Wave 1 — employee identity: the DB-touching half (not unit-tested
 * directly, per repo convention; the pure rules it uses live in employee.ts
 * and team.ts and are covered by their own *.test.ts files).
 *
 * Every function here takes businessId explicitly and includes it in every
 * WHERE/JOIN condition — RLS already confines all of this to one tenant, but
 * matching team-service.ts's belt-and-suspenders style keeps the intent
 * readable without relying on RLS alone.
 *
 * Not wired into any route yet: the PIN-login route and JWT session model
 * (src/app/api/auth/pin-login/route.ts, auth-edge.ts) are untouched by this
 * wave. This module is the foundation Wave 2 (Login Experience Redesign)
 * will call into.
 */
import bcrypt from "bcryptjs";
import type { PoolClient } from "pg";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, RegistrationResponseJSON } from "@simplewebauthn/server";
import { getPool, query, withoutTenantScope } from "./db";
import { isValidPin } from "./team";
import {
  generateSessionToken,
  isIssuableCredentialType,
  sessionExpiry,
  type EmployeeCredentialType,
} from "./employee";
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
  type CredentialDescriptor,
} from "./webauthn";

export class EmployeeError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

/** Anything that can run a statement — a pooled client, or the pool itself. */
interface Executor {
  query: PoolClient["query"];
}

async function auditEmployee(
  client: Executor,
  params: {
    businessId: string;
    actorId: string | null;
    action: string;
    employeeId: string;
    payload?: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'employee', $4, $5)`,
    [
      params.businessId,
      params.actorId,
      params.action,
      params.employeeId,
      JSON.stringify(params.payload ?? null),
    ],
  );
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface EmployeeProfile {
  id: string;
  businessId: string;
  employeeCode: string | null;
  phone: string | null;
  photoUrl: string | null;
  hiredAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EmployeeRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  employee_code: string | null;
  phone: string | null;
  photo_url: string | null;
  hired_at: Date | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

function toProfile(row: EmployeeRow): EmployeeProfile {
  return {
    id: row.id,
    businessId: row.business_id,
    employeeCode: row.employee_code,
    phone: row.phone,
    photoUrl: row.photo_url,
    hiredAt: row.hired_at ? row.hired_at.toISOString().slice(0, 10) : null,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Creates the employee profile row for a membership if it doesn't exist yet,
 * and returns it either way. `employeeId` is users.id — employees is a 1:1
 * extension of an existing membership, not a new identity of its own.
 */
export async function ensureEmployeeProfile(
  employeeId: string,
  businessId: string,
): Promise<EmployeeProfile> {
  const { rows } = await query<EmployeeRow>(
    `INSERT INTO employees (id, business_id)
     VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET updated_at = employees.updated_at
     RETURNING id, business_id, employee_code, phone, photo_url, hired_at, notes, created_at, updated_at`,
    [employeeId, businessId],
  );
  return toProfile(rows[0]);
}

export async function getEmployeeProfile(
  employeeId: string,
  businessId: string,
): Promise<EmployeeProfile | null> {
  const { rows } = await query<EmployeeRow>(
    `SELECT id, business_id, employee_code, phone, photo_url, hired_at, notes, created_at, updated_at
       FROM employees WHERE id = $1 AND business_id = $2`,
    [employeeId, businessId],
  );
  return rows[0] ? toProfile(rows[0]) : null;
}

export interface UpdateEmployeeProfileInput {
  employeeCode?: string | null;
  phone?: string | null;
  photoUrl?: string | null;
  hiredAt?: string | null;
  notes?: string | null;
}

export async function updateEmployeeProfile(
  employeeId: string,
  businessId: string,
  actorId: string | null,
  input: UpdateEmployeeProfileInput,
): Promise<EmployeeProfile> {
  await ensureEmployeeProfile(employeeId, businessId);
  const { rows } = await query<EmployeeRow>(
    `UPDATE employees
        SET employee_code = COALESCE($3, employee_code),
            phone = COALESCE($4, phone),
            photo_url = COALESCE($5, photo_url),
            hired_at = COALESCE($6, hired_at),
            notes = COALESCE($7, notes),
            updated_at = now()
      WHERE id = $1 AND business_id = $2
      RETURNING id, business_id, employee_code, phone, photo_url, hired_at, notes, created_at, updated_at`,
    [
      employeeId,
      businessId,
      input.employeeCode ?? null,
      input.phone ?? null,
      input.photoUrl ?? null,
      input.hiredAt ?? null,
      input.notes ?? null,
    ],
  );
  if (!rows[0]) throw new EmployeeError("employee_not_found", 404);
  await auditEmployee(getPool(), {
    businessId,
    actorId,
    action: "employee.profile_updated",
    employeeId,
    payload: input,
  });
  return toProfile(rows[0]);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface EmployeeCredentialSummary {
  id: string;
  employeeId: string;
  credentialType: EmployeeCredentialType;
  status: "active" | "revoked";
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

interface CredentialRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  credential_type: EmployeeCredentialType;
  status: "active" | "revoked";
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

function toCredentialSummary(row: CredentialRow): EmployeeCredentialSummary {
  return {
    id: row.id,
    employeeId: row.employee_id,
    credentialType: row.credential_type,
    status: row.status,
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

export async function listCredentials(
  employeeId: string,
  businessId: string,
): Promise<EmployeeCredentialSummary[]> {
  const { rows } = await query<CredentialRow>(
    `SELECT id, employee_id, credential_type, status, last_used_at, created_at, revoked_at
       FROM employee_credentials
      WHERE employee_id = $1 AND business_id = $2
      ORDER BY created_at DESC`,
    [employeeId, businessId],
  );
  return rows.map(toCredentialSummary);
}

/**
 * Issues a new credential, revoking any previously active credential of the
 * same type first — an employee has at most one live PIN at a time. Only
 * `pin` is issuable in Wave 1 (see employee.ts's ISSUABLE_CREDENTIAL_TYPES).
 */
export async function issueCredential(
  employeeId: string,
  businessId: string,
  actorId: string | null,
  credentialType: EmployeeCredentialType,
  secret: string,
): Promise<EmployeeCredentialSummary> {
  if (!isIssuableCredentialType(credentialType)) {
    throw new EmployeeError("credential_type_not_issuable");
  }
  if (credentialType === "pin" && !isValidPin(secret)) {
    throw new EmployeeError("invalid_pin");
  }

  await ensureEmployeeProfile(employeeId, businessId);
  const secretHash = await bcrypt.hash(secret, 10);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE employee_credentials
          SET status = 'revoked', revoked_at = now()
        WHERE employee_id = $1 AND business_id = $2 AND credential_type = $3 AND status = 'active'`,
      [employeeId, businessId, credentialType],
    );
    const { rows } = await client.query<CredentialRow>(
      `INSERT INTO employee_credentials (employee_id, business_id, credential_type, secret_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, employee_id, credential_type, status, last_used_at, created_at, revoked_at`,
      [employeeId, businessId, credentialType, secretHash],
    );
    await auditEmployee(client, {
      businessId,
      actorId,
      action: "employee.credential_issued",
      employeeId,
      payload: { credentialType },
    });
    await client.query("COMMIT");
    return toCredentialSummary(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeCredential(
  credentialId: string,
  businessId: string,
  actorId: string | null,
  /** Wave 3 — pass the caller's own employee id for a self-service revoke, so a guessed credential id belonging to someone else can't be revoked; omitted for an admin-initiated revoke. */
  ownerEmployeeId?: string,
): Promise<void> {
  const params = [credentialId, businessId];
  let ownerFilter = "";
  if (ownerEmployeeId) {
    params.push(ownerEmployeeId);
    ownerFilter = "AND employee_id = $3";
  }
  const { rows } = await query<{ employee_id: string }>(
    `UPDATE employee_credentials
        SET status = 'revoked', revoked_at = now()
      WHERE id = $1 AND business_id = $2 AND status = 'active' ${ownerFilter}
      RETURNING employee_id`,
    params,
  );
  if (!rows[0]) throw new EmployeeError("credential_not_found", 404);
  await auditEmployee(getPool(), {
    businessId,
    actorId,
    action: "employee.credential_revoked",
    employeeId: rows[0].employee_id,
    payload: { credentialId },
  });
}

/**
 * Checks a presented secret against every active credential of the given
 * type in the business, the same linear bcrypt-compare scan pin-login and
 * isPinTaken already use for the low-entropy, per-business-unique PIN case —
 * hashed secrets can't be looked up by equality.
 */
export async function verifyCredential(
  businessId: string,
  credentialType: EmployeeCredentialType,
  secret: string,
): Promise<string | null> {
  const { rows } = await query<{ id: string; employee_id: string; secret_hash: string }>(
    `SELECT id, employee_id, secret_hash
       FROM employee_credentials
      WHERE business_id = $1 AND credential_type = $2 AND status = 'active'`,
    [businessId, credentialType],
  );
  for (const row of rows) {
    if (await bcrypt.compare(secret, row.secret_hash)) {
      await query(`UPDATE employee_credentials SET last_used_at = now() WHERE id = $1`, [row.id]);
      return row.employee_id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// WebAuthn (Wave 3 — biometric authentication)
// ---------------------------------------------------------------------------
//
// A parallel path alongside issueCredential/verifyCredential above, not a
// caller of them: those two are built around a bcrypt-hashed shared secret,
// which a public-key credential isn't (see employee.ts's
// ISSUABLE_CREDENTIAL_TYPES comment). webauthn.ts owns the cryptography;
// everything here is what employee_credentials needs around it — resolving
// which rows to exclude/allow in a ceremony, and persisting what a verified
// one returns.

interface WebauthnCredentialRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  webauthn_credential_id: string;
  webauthn_public_key: string;
  webauthn_sign_count: string;
  webauthn_transports: string[] | null;
  display_hint: string | null;
  created_at: Date;
  last_used_at: Date | null;
}

async function activeWebauthnCredentials(
  employeeId: string,
  businessId: string,
): Promise<WebauthnCredentialRow[]> {
  const { rows } = await query<WebauthnCredentialRow>(
    `SELECT id, employee_id, webauthn_credential_id, webauthn_public_key, webauthn_sign_count,
            webauthn_transports, display_hint, created_at, last_used_at
       FROM employee_credentials
      WHERE employee_id = $1 AND business_id = $2 AND credential_type = 'webauthn' AND status = 'active'`,
    [employeeId, businessId],
  );
  return rows;
}

function toDescriptor(row: WebauthnCredentialRow): CredentialDescriptor {
  return {
    id: row.webauthn_credential_id,
    transports: (row.webauthn_transports as AuthenticatorTransportFuture[] | null) ?? null,
  };
}

export interface WebauthnCredentialSummary {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The caller's own registered authenticators — for a self-service "your devices" list, never exposed to another employee. */
export async function listWebauthnCredentials(
  employeeId: string,
  businessId: string,
): Promise<WebauthnCredentialSummary[]> {
  const rows = await activeWebauthnCredentials(employeeId, businessId);
  return rows.map((row) => ({
    id: row.id,
    label: row.display_hint,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  }));
}

/** Step 1 of registering a new authenticator — self-service, called by the already-authenticated employee. */
export async function beginWebauthnRegistration(
  employeeId: string,
  businessId: string,
  displayName: string,
) {
  await ensureEmployeeProfile(employeeId, businessId);
  const existing = await activeWebauthnCredentials(employeeId, businessId);
  return buildRegistrationOptions(employeeId, businessId, displayName, existing.map(toDescriptor));
}

/** Step 2: verifies what the authenticator returned and stores the new credential. */
export async function completeWebauthnRegistration(
  employeeId: string,
  businessId: string,
  actorId: string | null,
  response: RegistrationResponseJSON,
  challengeToken: string,
  deviceLabel?: string | null,
): Promise<EmployeeCredentialSummary> {
  const verified = await verifyRegistration(employeeId, businessId, response, challengeToken);
  if (!verified) throw new EmployeeError("webauthn_verification_failed");

  await ensureEmployeeProfile(employeeId, businessId);
  try {
    const { rows } = await query<CredentialRow>(
      `INSERT INTO employee_credentials
         (employee_id, business_id, credential_type, display_hint,
          webauthn_credential_id, webauthn_public_key, webauthn_sign_count, webauthn_transports)
       VALUES ($1, $2, 'webauthn', $3, $4, $5, $6, $7)
       RETURNING id, employee_id, credential_type, status, last_used_at, created_at, revoked_at`,
      [
        employeeId,
        businessId,
        deviceLabel ?? null,
        verified.credentialId,
        verified.publicKey,
        verified.signCount,
        verified.transports,
      ],
    );
    await auditEmployee(getPool(), {
      businessId,
      actorId,
      action: "employee.webauthn_registered",
      employeeId,
      payload: { credentialId: rows[0].id },
    });
    return toCredentialSummary(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new EmployeeError("credential_already_registered");
    }
    throw err;
  }
}

/**
 * Step 1 of a biometric login — public, called before any session exists.
 * `employeeId` is already known (the picker chose them before offering PIN
 * or biometric, same as pin-login's `employeeId` narrowing); null means this
 * employee has no active authenticator to offer, so the caller falls back to
 * the PIN pad instead of showing a biometric prompt with nothing to sign.
 */
export async function beginWebauthnAuthentication(employeeId: string, businessId: string) {
  const existing = await activeWebauthnCredentials(employeeId, businessId);
  if (existing.length === 0) return null;
  return buildAuthenticationOptions(employeeId, businessId, existing.map(toDescriptor));
}

/**
 * Step 2: verifies the signed assertion against whichever of the employee's
 * credentials it claims to be (`response.id`), advances that row's signature
 * counter (replay/clone detection), and returns the credential id used —
 * `pin-login`-style session/JWT minting happens in the route, same as PIN.
 */
export async function completeWebauthnAuthentication(
  employeeId: string,
  businessId: string,
  response: AuthenticationResponseJSON,
  challengeToken: string,
): Promise<{ credentialId: string } | null> {
  const candidates = await activeWebauthnCredentials(employeeId, businessId);
  const match = candidates.find((row) => row.webauthn_credential_id === response.id);
  if (!match) return null;

  const result = await verifyAuthentication(employeeId, businessId, response, challengeToken, {
    credentialId: match.webauthn_credential_id,
    publicKey: match.webauthn_public_key,
    signCount: Number(match.webauthn_sign_count),
    transports: (match.webauthn_transports as AuthenticatorTransportFuture[] | null) ?? null,
  });
  if (!result) return null;

  await query(
    `UPDATE employee_credentials SET webauthn_sign_count = $2, last_used_at = now() WHERE id = $1`,
    [match.id, result.newSignCount],
  );
  return { credentialId: match.id };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface EmployeeSession {
  id: string;
  employeeId: string;
  businessId: string;
  locationId: string | null;
  issuedAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  business_id: string;
  location_id: string | null;
  issued_at: Date;
  expires_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

function toSession(row: SessionRow): EmployeeSession {
  return {
    id: row.id,
    employeeId: row.employee_id,
    businessId: row.business_id,
    locationId: row.location_id,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

export interface CreateSessionInput {
  locationId?: string | null;
  credentialId?: string | null;
  deviceLabel?: string | null;
}

/** Issues a new, server-side-revocable session and returns the one-time plaintext token alongside it. */
export async function createSession(
  employeeId: string,
  businessId: string,
  input: CreateSessionInput = {},
): Promise<{ token: string; session: EmployeeSession }> {
  await ensureEmployeeProfile(employeeId, businessId);
  const { token, tokenHash } = generateSessionToken();
  const { rows } = await query<SessionRow>(
    `INSERT INTO employee_sessions
       (employee_id, business_id, location_id, credential_id, token_hash, device_label, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, employee_id, business_id, location_id, issued_at, expires_at, last_seen_at, revoked_at`,
    [
      employeeId,
      businessId,
      input.locationId ?? null,
      input.credentialId ?? null,
      tokenHash,
      input.deviceLabel ?? null,
      sessionExpiry(),
    ],
  );
  return { token, session: toSession(rows[0]) };
}

export async function listActiveSessions(
  employeeId: string,
  businessId: string,
): Promise<EmployeeSession[]> {
  const { rows } = await query<SessionRow>(
    `SELECT id, employee_id, business_id, location_id, issued_at, expires_at, last_seen_at, revoked_at
       FROM employee_sessions
      WHERE employee_id = $1 AND business_id = $2 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY issued_at DESC`,
    [employeeId, businessId],
  );
  return rows.map(toSession);
}

export async function touchSession(sessionId: string, businessId: string): Promise<void> {
  await query(
    `UPDATE employee_sessions SET last_seen_at = now() WHERE id = $1 AND business_id = $2`,
    [sessionId, businessId],
  );
}

export async function revokeSession(
  sessionId: string,
  businessId: string,
  actorId: string | null,
): Promise<void> {
  const { rows } = await query<{ employee_id: string }>(
    `UPDATE employee_sessions
        SET revoked_at = now()
      WHERE id = $1 AND business_id = $2 AND revoked_at IS NULL
      RETURNING employee_id`,
    [sessionId, businessId],
  );
  if (!rows[0]) throw new EmployeeError("session_not_found", 404);
  await auditEmployee(getPool(), {
    businessId,
    actorId,
    action: "employee.session_revoked",
    employeeId: rows[0].employee_id,
    payload: { sessionId },
  });
}

// ---------------------------------------------------------------------------
// Login (Wave 2 — Login Experience Redesign)
// ---------------------------------------------------------------------------

/**
 * Resolves which business a PIN-login-family request (the PIN itself, or the
 * employee-picker roster that precedes it) is for. Lifted verbatim out of
 * `pin-login/route.ts` (Wave 1 predates this module having a caller for it)
 * so `pin-login/roster/route.ts` doesn't duplicate the same business-scoping
 * rules — see that route's original comment for why each fallback exists.
 */
export async function resolveLoginBusinessId(body: {
  businessId?: string;
  businessSlug?: string;
  locationId?: string;
}): Promise<{ businessId: string | null; error: string | null }> {
  return withoutTenantScope("login", async () => {
    if (body.businessId) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM businesses WHERE id = $1 AND status = 'active'`,
        [body.businessId],
      );
      return { businessId: rows[0]?.id ?? null, error: rows[0] ? null : "unknown_business" };
    }

    if (body.businessSlug) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM businesses WHERE slug = $1 AND status = 'active'`,
        [body.businessSlug],
      );
      return { businessId: rows[0]?.id ?? null, error: rows[0] ? null : "unknown_business" };
    }

    if (body.locationId) {
      const { rows } = await query<{ business_id: string }>(
        `SELECT l.business_id FROM locations l
           JOIN businesses b ON b.id = l.business_id
          WHERE l.id = $1 AND b.status = 'active'`,
        [body.locationId],
      );
      return {
        businessId: rows[0]?.business_id ?? null,
        error: rows[0] ? null : "unknown_location",
      };
    }

    const { rows } = await query<{ id: string }>(
      `SELECT id FROM businesses WHERE status = 'active' LIMIT 2`,
    );
    if (rows.length === 1) return { businessId: rows[0].id, error: null };
    return { businessId: null, error: rows.length === 0 ? "unknown_business" : "business_required" };
  });
}

export interface LoginRosterEntry {
  id: string;
  fullName: string;
  role: string;
  photoUrl: string | null;
  /** Wave 3 — whether the login screen should offer a biometric prompt for this name before falling back to the PIN pad. */
  hasWebauthn: boolean;
}

interface RosterRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  role: string;
  photo_url: string | null;
  has_webauthn: boolean;
}

/**
 * The name+photo picker shown before the PIN pad (Wave 2). Deliberately the
 * same eligibility rule pin-login itself checks (`is_active`, a PIN role, a
 * PIN actually set) so a name never appears here that pin-login would then
 * reject — and nothing more sensitive than a name, role, and photo (plus,
 * since Wave 3, a plain boolean for whether a biometric prompt makes sense)
 * is returned, since this runs before any credential has been presented.
 */
export async function loginRoster(
  businessId: string,
  locationId?: string | null,
): Promise<LoginRosterEntry[]> {
  const params: unknown[] = [];
  let locationFilter = "";
  if (locationId) {
    params.push(locationId);
    locationFilter = "AND u.location_id = $1";
  }
  const { rows } = await query<RosterRow>(
    `SELECT u.id, u.full_name, u.role::text AS role, e.photo_url,
            EXISTS (
              SELECT 1 FROM employee_credentials c
               WHERE c.employee_id = u.id AND c.credential_type = 'webauthn' AND c.status = 'active'
            ) AS has_webauthn
       FROM users u
       LEFT JOIN employees e ON e.id = u.id
      WHERE u.is_active
        AND u.role IN ('cashier', 'waiter', 'kitchen')
        AND u.pin_hash IS NOT NULL
        ${locationFilter}
      ORDER BY u.full_name`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    role: row.role,
    photoUrl: row.photo_url,
    hasWebauthn: row.has_webauthn,
  }));
}
