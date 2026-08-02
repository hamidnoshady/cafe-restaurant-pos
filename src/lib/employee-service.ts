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
import { getPool, query } from "./db";
import { isValidPin } from "./team";
import {
  generateSessionToken,
  isIssuableCredentialType,
  sessionExpiry,
  type EmployeeCredentialType,
} from "./employee";

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
): Promise<void> {
  const { rows } = await query<{ employee_id: string }>(
    `UPDATE employee_credentials
        SET status = 'revoked', revoked_at = now()
      WHERE id = $1 AND business_id = $2 AND status = 'active'
      RETURNING employee_id`,
    [credentialId, businessId],
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
