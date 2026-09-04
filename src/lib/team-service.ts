/**
 * Phase 13 — teams & permissions: the DB-touching half (not unit-tested
 * directly, per repo convention; the pure rules it enforces live in team.ts
 * and are covered by team.test.ts).
 *
 * This module is the ONLY place a membership is created. That matters: Phase
 * 12 moved the login identity into `platform_users`, and a member created
 * without one has a row in `users` and no way to sign in. Routing every
 * creation path — the setup wizard, the team screen, invitation acceptance —
 * through `createMembership` is what keeps that from happening again.
 */
import bcrypt from "bcryptjs";
import { BCRYPT_COST } from "@/lib/password-hashing";
import type { PoolClient } from "pg";
import { getPool, query, withoutTenantScope } from "./db";
import type { Role } from "./auth-edge";
import {
  effectivePermissions,
  parseOverrides,
  type PermissionOverrides,
} from "./permissions";
import { activeMemberCount, planLimitsFor } from "./plan-limits";
import {
  checkLastOwner,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiry,
  invitationStatus,
  isPasswordRole,
  isPinRole,
  type InvitationStatus,
  type MemberSummary,
} from "./team";

export class TeamError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Reading the team
// ---------------------------------------------------------------------------

export interface TeamMember {
  id: string;
  role: Role;
  fullName: string;
  email: string | null;
  isActive: boolean;
  hasPin: boolean;
  /** Whether this membership can sign in with a password (has a global identity). */
  hasLogin: boolean;
  locationIds: string[];
  defaultLocationId: string | null;
  overrides: PermissionOverrides;
  effectivePermissions: string[];
  createdAt: string;
}

interface MemberRow extends Record<string, unknown> {
  id: string;
  role: Role;
  full_name: string;
  email: string | null;
  is_active: boolean;
  has_pin: boolean;
  has_login: boolean;
  default_location_id: string | null;
  permissions: unknown;
  location_ids: string[] | null;
  created_at: Date;
}

function toMember(row: MemberRow): TeamMember {
  const overrides = parseOverrides(row.permissions);
  return {
    id: row.id,
    role: row.role,
    fullName: row.full_name,
    email: row.email,
    isActive: row.is_active,
    hasPin: row.has_pin,
    hasLogin: row.has_login,
    locationIds: row.location_ids ?? [],
    defaultLocationId: row.default_location_id,
    overrides,
    effectivePermissions: [...effectivePermissions(row.role, overrides)].sort(),
    createdAt: row.created_at.toISOString(),
  };
}

/** Every membership of the current business. RLS confines this to one tenant. */
export async function listMembers(businessId: string): Promise<TeamMember[]> {
  const { rows } = await query<MemberRow>(
    `SELECT u.id, u.role, u.full_name, u.email, u.is_active,
            (u.pin_hash IS NOT NULL) AS has_pin,
            (u.platform_user_id IS NOT NULL) AS has_login,
            u.location_id AS default_location_id,
            u.permissions, u.created_at,
            coalesce(
              (SELECT array_agg(ul.location_id) FROM user_locations ul WHERE ul.user_id = u.id),
              '{}'
            ) AS location_ids
       FROM users u
      WHERE u.business_id = $1
      ORDER BY u.created_at`,
    [businessId],
  );
  return rows.map(toMember);
}

/** The reduced view the lockout rules need. */
async function memberSummaries(businessId: string): Promise<MemberSummary[]> {
  const { rows } = await query<{ id: string; role: Role; is_active: boolean }>(
    `SELECT id, role, is_active FROM users WHERE business_id = $1`,
    [businessId],
  );
  return rows.map((r) => ({ id: r.id, role: r.role, isActive: r.is_active }));
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Anything that can run a statement — a pooled client inside a transaction, or
 * the pool itself for a standalone write.
 */
interface Executor {
  query: PoolClient["query"];
}

/**
 * Records a membership change. Every mutation in this module writes one, with
 * the actor, the target, and enough before/after to answer "who changed this".
 */
async function auditMembership(
  client: Executor,
  params: {
    businessId: string;
    actorId: string | null;
    action: string;
    targetUserId: string;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'user', $4, $5)`,
    [
      params.businessId,
      params.actorId,
      params.action,
      params.targetUserId,
      JSON.stringify({
        before: params.before ?? null,
        after: params.after ?? null,
      }),
    ],
  );
}

// ---------------------------------------------------------------------------
// Creating a membership — the one path
// ---------------------------------------------------------------------------

export interface CreateMembershipInput {
  businessId: string;
  role: Role;
  fullName: string;
  /** Required for password roles; ignored for PIN roles. */
  email?: string | null;
  /** Required for a password role whose identity doesn't exist yet. */
  password?: string | null;
  /** Required for PIN roles. */
  pin?: string | null;
  locationIds?: string[];
  defaultLocationId?: string | null;
  overrides?: PermissionOverrides;
  actorId: string | null;
}

/**
 * Creates a membership, and the global identity behind it when the role signs
 * in with a password.
 *
 * If the email already belongs to the platform the existing identity is
 * *linked* rather than duplicated — that is how a person ends up a member of
 * two businesses, and it is why no password is needed in that case: they
 * already have one, and this doesn't change it.
 */
export async function createMembership(
  input: CreateMembershipInput,
): Promise<{ userId: string }> {
  const fullName = input.fullName.trim();
  const email = input.email?.trim().toLowerCase() || null;

  if (!fullName) throw new TeamError("missing_fields");

  if (isPasswordRole(input.role) && !email)
    throw new TeamError("email_required");
  if (isPinRole(input.role) && !input.pin) throw new TeamError("pin_required");

  const limits = await planLimitsFor(input.businessId);
  if (
    limits.memberLimit !== null &&
    (await activeMemberCount(input.businessId)) >= limits.memberLimit
  ) {
    throw new TeamError("member_limit_exceeded", 403);
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    let platformUserId: string | null = null;
    if (isPasswordRole(input.role) && email) {
      // The identity lookup spans tenants by nature — the same person may
      // already be a member elsewhere — so it runs bypassed, briefly and
      // explicitly, on this same connection.
      await client.query("SELECT set_config('app.rls_bypass', 'on', true)");
      const { rows: existing } = await client.query<{ id: string }>(
        "SELECT id FROM platform_users WHERE email = $1",
        [email],
      );

      if (existing[0]) {
        platformUserId = existing[0].id;
      } else {
        if (!input.password || input.password.length < 8) {
          await client.query("ROLLBACK");
          throw new TeamError("weak_password");
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO platform_users (email, password_hash, full_name)
           VALUES ($1, $2, $3) RETURNING id`,
          [email, await bcrypt.hash(input.password, BCRYPT_COST), fullName],
        );
        platformUserId = rows[0].id;
      }
      await client.query("SELECT set_config('app.rls_bypass', '', true)");
      await client.query("SELECT set_config('app.business_id', $1, true)", [
        input.businessId,
      ]);

      const { rows: dup } = await client.query(
        "SELECT 1 FROM users WHERE business_id = $1 AND platform_user_id = $2",
        [input.businessId, platformUserId],
      );
      if (dup.length > 0) {
        await client.query("ROLLBACK");
        throw new TeamError("already_a_member", 409);
      }
    }

    const pinHash = input.pin ? await bcrypt.hash(input.pin, BCRYPT_COST) : null;

    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO users
         (business_id, platform_user_id, role, full_name, email, pin_hash, location_id, permissions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.businessId,
        platformUserId,
        input.role,
        fullName,
        email,
        pinHash,
        input.defaultLocationId ?? null,
        JSON.stringify(input.overrides ?? {}),
      ],
    );
    const userId = created[0].id;

    if (input.locationIds?.length) {
      await client.query(
        "INSERT INTO user_locations (user_id, location_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
        [userId, input.locationIds],
      );
    }

    await auditMembership(client, {
      businessId: input.businessId,
      actorId: input.actorId,
      action: "team.member_created",
      targetUserId: userId,
      after: { role: input.role, fullName, email, isActive: true },
    });

    await client.query("COMMIT");
    return { userId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Whether a 4-digit PIN is already in use within a business.
 *
 * PINs are bcrypt-hashed, so this can't be a unique index — every candidate
 * has to be compared against every active PIN in the business. Scoped to the
 * business (not, as before Phase 12, to the whole table).
 */
export async function isPinTaken(
  businessId: string,
  pin: string,
  exceptUserId?: string,
): Promise<boolean> {
  const { rows } = await query<{ id: string; pin_hash: string }>(
    `SELECT id, pin_hash FROM users
      WHERE business_id = $1 AND is_active AND pin_hash IS NOT NULL`,
    [businessId],
  );
  for (const row of rows) {
    if (row.id === exceptUserId) continue;
    if (await bcrypt.compare(pin, row.pin_hash)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Updating a membership
// ---------------------------------------------------------------------------

export interface UpdateMembershipInput {
  businessId: string;
  userId: string;
  actorId: string | null;
  role?: Role;
  fullName?: string;
  isActive?: boolean;
  overrides?: PermissionOverrides;
  locationIds?: string[];
  defaultLocationId?: string | null;
}

export async function updateMembership(
  input: UpdateMembershipInput,
): Promise<void> {
  const members = await memberSummaries(input.businessId);
  const target = members.find((m) => m.id === input.userId);
  if (!target) throw new TeamError("not_found", 404);

  const lockout = checkLastOwner(members, input.userId, {
    role: input.role,
    isActive: input.isActive,
  });
  if (lockout) throw new TeamError(lockout, 409);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: beforeRows } = await client.query(
      `SELECT role, full_name, email, is_active, permissions, location_id
         FROM users WHERE id = $1 AND business_id = $2`,
      [input.userId, input.businessId],
    );
    const before = beforeRows[0];
    if (!before) {
      await client.query("ROLLBACK");
      throw new TeamError("not_found", 404);
    }

    await client.query(
      `UPDATE users
          SET role        = coalesce($3, role),
              full_name   = coalesce($4, full_name),
              is_active   = coalesce($5, is_active),
              permissions = coalesce($6, permissions),
              location_id = CASE WHEN $7::boolean THEN $8::uuid ELSE location_id END,
              updated_at  = now()
        WHERE id = $1 AND business_id = $2`,
      [
        input.userId,
        input.businessId,
        input.role ?? null,
        input.fullName?.trim() ?? null,
        input.isActive ?? null,
        input.overrides ? JSON.stringify(input.overrides) : null,
        input.defaultLocationId !== undefined,
        input.defaultLocationId ?? null,
      ],
    );

    if (input.locationIds) {
      await client.query("DELETE FROM user_locations WHERE user_id = $1", [
        input.userId,
      ]);
      if (input.locationIds.length > 0) {
        await client.query(
          "INSERT INTO user_locations (user_id, location_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
          [input.userId, input.locationIds],
        );
      }
    }

    const { rows: afterRows } = await client.query(
      `SELECT role, full_name, email, is_active, permissions, location_id
         FROM users WHERE id = $1`,
      [input.userId],
    );

    await auditMembership(client, {
      businessId: input.businessId,
      actorId: input.actorId,
      action: "team.member_updated",
      targetUserId: input.userId,
      before,
      after: afterRows[0],
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Removes a membership.
 *
 * Decision (Phase 13 Q3): historical rows stay attributed. Every foreign key
 * to `users` is ON DELETE SET NULL, so deleting would silently orphan "who
 * opened this order" across the ledger and the audit trail. A removed member
 * is deactivated and stripped of credentials instead — they can no longer sign
 * in by any route, while the history stays readable.
 *
 * Phase 20 Wave 2: also revokes any active `employee_credentials`/
 * `employee_sessions` rows, the same deactivation the `pin_hash`/
 * `password_hash` strip below already does for the pre-Phase-20 credential
 * columns. Landing this alongside Wave 2's login wiring (rather than in
 * Wave 1, which only added the tables) is deliberate — see the phase doc's
 * "Open questions for Wave 2": before pin-login mints sessions, a removed
 * member's still-`active` row here was inert, so revoking it earlier would
 * have bought nothing.
 */
export async function removeMembership(
  businessId: string,
  userId: string,
  actorId: string | null,
): Promise<void> {
  const members = await memberSummaries(businessId);
  if (!members.some((m) => m.id === userId))
    throw new TeamError("not_found", 404);

  const lockout = checkLastOwner(members, userId, { remove: true });
  if (lockout) throw new TeamError(lockout, 409);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: before } = await client.query(
      "SELECT role, full_name, email, is_active FROM users WHERE id = $1 AND business_id = $2",
      [userId, businessId],
    );
    if (!before[0]) {
      await client.query("ROLLBACK");
      throw new TeamError("not_found", 404);
    }

    await client.query(
      `UPDATE users
          SET is_active = false, pin_hash = NULL, password_hash = NULL,
              platform_user_id = NULL, updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [userId, businessId],
    );
    await client.query("DELETE FROM user_locations WHERE user_id = $1", [
      userId,
    ]);
    await client.query(
      `UPDATE employee_credentials
          SET status = 'revoked', revoked_at = now()
        WHERE employee_id = $1 AND business_id = $2 AND status = 'active'`,
      [userId, businessId],
    );
    await client.query(
      `UPDATE employee_sessions
          SET revoked_at = now()
        WHERE employee_id = $1 AND business_id = $2 AND revoked_at IS NULL`,
      [userId, businessId],
    );
    // Phase 20 Wave 5 — a removed member's shift (if left open) would
    // otherwise stay open forever now that nothing else about their access
    // is still live.
    await client.query(
      `UPDATE employee_shifts
          SET ended_at = now(), closed_by = $3
        WHERE employee_id = $1 AND business_id = $2 AND ended_at IS NULL`,
      [userId, businessId, actorId],
    );

    await auditMembership(client, {
      businessId,
      actorId,
      action: "team.member_removed",
      targetUserId: userId,
      before: before[0],
      after: { isActive: false, credentialsRevoked: true },
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Sets a member's PIN (owner action) or their own (self-service). */
export async function setPin(
  businessId: string,
  userId: string,
  pin: string,
  actorId: string | null,
): Promise<void> {
  if (await isPinTaken(businessId, pin, userId))
    throw new TeamError("pin_taken", 409);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      "UPDATE users SET pin_hash = $3, updated_at = now() WHERE id = $1 AND business_id = $2",
      [userId, businessId, await bcrypt.hash(pin, BCRYPT_COST)],
    );
    if (!rowCount) {
      await client.query("ROLLBACK");
      throw new TeamError("not_found", 404);
    }
    await auditMembership(client, {
      businessId,
      actorId,
      action: "team.pin_changed",
      targetUserId: userId,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Changes the password on the identity behind a membership.
 *
 * The identity is global, so this affects every business that person belongs
 * to — which is correct (it is one login) but worth being explicit about: an
 * owner force-resetting a member's password is resetting that person's
 * platform password, not just their access here.
 */
export async function setPassword(
  businessId: string,
  userId: string,
  newPassword: string,
  actorId: string | null,
): Promise<void> {
  if (newPassword.length < 8) throw new TeamError("weak_password");

  const { rows } = await query<{ platform_user_id: string | null }>(
    "SELECT platform_user_id FROM users WHERE id = $1 AND business_id = $2",
    [userId, businessId],
  );
  const platformUserId = rows[0]?.platform_user_id;
  if (!rows[0]) throw new TeamError("not_found", 404);
  if (!platformUserId) throw new TeamError("no_login", 409);

  const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
  // Not "platform" administration — an owner acting inside their own business
  // triggered this. The bypass is narrow and already justified by the lookup
  // above: platformUserId was only ever reached via a users row this business
  // owns, and platform_users itself carries no business_id to scope by.
  await withoutTenantScope("identity", async () => {
    await query(
      "UPDATE platform_users SET password_hash = $2, updated_at = now() WHERE id = $1",
      [platformUserId, hash],
    );
  });

  await auditMembership(getPool(), {
    businessId,
    actorId,
    action: "team.password_changed",
    targetUserId: userId,
  });
}

/** Verifies a person's current password — required before they change it themselves. */
export async function verifyPassword(
  userId: string,
  password: string,
): Promise<boolean> {
  return withoutTenantScope("login", async () => {
    const { rows } = await query<{ password_hash: string }>(
      `SELECT p.password_hash FROM users u
         JOIN platform_users p ON p.id = u.platform_user_id
        WHERE u.id = $1`,
      [userId],
    );
    if (!rows[0]) return false;
    return bcrypt.compare(password, rows[0].password_hash);
  });
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export interface InvitationSummary {
  id: string;
  email: string;
  role: Role;
  fullName: string;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
}

export async function listInvitations(
  businessId: string,
): Promise<InvitationSummary[]> {
  const { rows } = await query<{
    id: string;
    email: string;
    role: Role;
    full_name: string;
    expires_at: Date;
    accepted_at: Date | null;
    revoked_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, email::text AS email, role, full_name, expires_at, accepted_at, revoked_at, created_at
       FROM invitations WHERE business_id = $1 ORDER BY created_at DESC`,
    [businessId],
  );

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    fullName: r.full_name,
    status: invitationStatus({
      expiresAt: r.expires_at,
      acceptedAt: r.accepted_at,
      revokedAt: r.revoked_at,
    }),
    expiresAt: r.expires_at.toISOString(),
    createdAt: r.created_at.toISOString(),
  }));
}

export interface CreateInvitationInput {
  businessId: string;
  email: string;
  role: Role;
  fullName: string;
  overrides?: PermissionOverrides;
  locationIds?: string[];
  actorId: string | null;
}

/**
 * Creates an invitation and returns the one-time token.
 *
 * Re-inviting an address supersedes any invitation still pending for it — the
 * partial unique index in migration 0022 would otherwise reject the insert,
 * and leaving several live tokens for one person is worse than replacing them.
 */
export async function createInvitation(
  input: CreateInvitationInput,
): Promise<{ token: string; invitationId: string }> {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  if (!email || !fullName) throw new TeamError("missing_fields");
  if (!isPasswordRole(input.role)) throw new TeamError("role_not_invitable");

  const { rows: existingMember } = await query(
    `SELECT 1 FROM users WHERE business_id = $1 AND email = $2 AND is_active`,
    [input.businessId, email],
  );
  if (existingMember.length > 0) throw new TeamError("already_a_member", 409);

  const { token, tokenHash } = generateInvitationToken();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE invitations SET revoked_at = now()
        WHERE business_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [input.businessId, email],
    );

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO invitations
         (business_id, email, role, full_name, permissions, location_ids, token_hash,
          expires_at, invited_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        input.businessId,
        email,
        input.role,
        fullName,
        JSON.stringify(input.overrides ?? {}),
        input.locationIds ?? [],
        tokenHash,
        invitationExpiry(),
        input.actorId,
      ],
    );

    await client.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'team.invited', 'invitation', $3, $4)`,
      [
        input.businessId,
        input.actorId,
        rows[0].id,
        JSON.stringify({ email, role: input.role }),
      ],
    );

    await client.query("COMMIT");
    return { token, invitationId: rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeInvitation(
  businessId: string,
  invitationId: string,
  actorId: string | null,
): Promise<void> {
  const { rowCount } = await query(
    `UPDATE invitations SET revoked_at = now()
      WHERE id = $1 AND business_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [invitationId, businessId],
  );
  if (!rowCount) throw new TeamError("not_found", 404);

  await query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id)
     VALUES ($1, $2, 'team.invitation_revoked', 'invitation', $3)`,
    [businessId, actorId, invitationId],
  );
}

export interface InvitationPreview {
  businessName: string;
  email: string;
  fullName: string;
  role: Role;
  /** True when this email already has a platform login, so no password is needed. */
  hasExistingLogin: boolean;
}

/**
 * Looks up an invitation by its presented token.
 *
 * Runs bypassed: whoever is accepting has no session yet, and by definition no
 * membership of the business that invited them. The token is the credential.
 */
export async function previewInvitation(
  token: string,
): Promise<InvitationPreview> {
  return withoutTenantScope("login", async () => {
    const { rows } = await query<{
      email: string;
      full_name: string;
      role: Role;
      business_name: string;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
      has_login: boolean;
    }>(
      `SELECT i.email::text AS email, i.full_name, i.role, b.name AS business_name,
              i.expires_at, i.accepted_at, i.revoked_at,
              EXISTS (SELECT 1 FROM platform_users p WHERE p.email = i.email) AS has_login
         FROM invitations i
         JOIN businesses b ON b.id = i.business_id
        WHERE i.token_hash = $1`,
      [hashInvitationToken(token)],
    );

    const invitation = rows[0];
    if (!invitation) throw new TeamError("invalid_invitation", 404);

    const status = invitationStatus({
      expiresAt: invitation.expires_at,
      acceptedAt: invitation.accepted_at,
      revokedAt: invitation.revoked_at,
    });
    if (status !== "pending") throw new TeamError(`invitation_${status}`, 409);

    return {
      businessName: invitation.business_name,
      email: invitation.email,
      fullName: invitation.full_name,
      role: invitation.role,
      hasExistingLogin: invitation.has_login,
    };
  });
}

export interface AcceptInvitationResult {
  businessId: string;
  businessSlug: string;
  businessSubdomain: string;
  userId: string;
  platformUserId: string;
  role: Role;
  fullName: string;
  locationId: string | null;
}

/**
 * Accepts an invitation, creating the membership (and the identity if this is
 * the person's first business).
 *
 * The whole thing is one transaction against a row locked with FOR UPDATE, so
 * two people racing the same link produce one membership and one failure
 * rather than two memberships.
 */
export async function acceptInvitation(
  token: string,
  password: string | null,
): Promise<AcceptInvitationResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Acceptance necessarily crosses the boundary: the acceptor is not yet a
    // member of the business that invited them.
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

    const { rows } = await client.query<{
      id: string;
      business_id: string;
      business_slug: string;
      business_subdomain: string;
      email: string;
      role: Role;
      full_name: string;
      permissions: unknown;
      location_ids: string[];
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT i.id, i.business_id, b.slug::text AS business_slug,
              b.subdomain::text AS business_subdomain, i.email::text AS email,
              i.role, i.full_name, i.permissions, i.location_ids, i.expires_at,
              i.accepted_at, i.revoked_at
         FROM invitations i
         JOIN businesses b ON b.id = i.business_id
        WHERE i.token_hash = $1 FOR UPDATE OF i`,
      [hashInvitationToken(token)],
    );

    const invitation = rows[0];
    if (!invitation) {
      await client.query("ROLLBACK");
      throw new TeamError("invalid_invitation", 404);
    }

    const status = invitationStatus({
      expiresAt: invitation.expires_at,
      acceptedAt: invitation.accepted_at,
      revokedAt: invitation.revoked_at,
    });
    if (status !== "pending") {
      await client.query("ROLLBACK");
      throw new TeamError(`invitation_${status}`, 409);
    }

    const { rows: identityRows } = await client.query<{ id: string }>(
      "SELECT id FROM platform_users WHERE email = $1",
      [invitation.email],
    );

    let platformUserId: string;
    if (identityRows[0]) {
      platformUserId = identityRows[0].id;
    } else {
      if (!password || password.length < 8) {
        await client.query("ROLLBACK");
        throw new TeamError("weak_password");
      }
      const { rows: created } = await client.query<{ id: string }>(
        `INSERT INTO platform_users (email, password_hash, full_name)
         VALUES ($1, $2, $3) RETURNING id`,
        [
          invitation.email,
          await bcrypt.hash(password, BCRYPT_COST),
          invitation.full_name,
        ],
      );
      platformUserId = created[0].id;
    }

    const { rows: dup } = await client.query(
      "SELECT 1 FROM users WHERE business_id = $1 AND platform_user_id = $2",
      [invitation.business_id, platformUserId],
    );
    if (dup.length > 0) {
      await client.query("ROLLBACK");
      throw new TeamError("already_a_member", 409);
    }

    // This route has no session — `client` has app.rls_bypass/app.business_id
    // set by hand above, so the check must run on this same connection (see
    // plan-limits.ts's module comment for why a fresh pool connection would
    // silently under-count here).
    const invitationLimits = await planLimitsFor(
      invitation.business_id,
      client,
    );
    if (
      invitationLimits.memberLimit !== null &&
      (await activeMemberCount(invitation.business_id, client)) >=
        invitationLimits.memberLimit
    ) {
      await client.query("ROLLBACK");
      throw new TeamError("member_limit_exceeded", 403);
    }

    const defaultLocationId = invitation.location_ids[0] ?? null;
    const { rows: member } = await client.query<{ id: string }>(
      `INSERT INTO users
         (business_id, platform_user_id, role, full_name, email, location_id, permissions)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        invitation.business_id,
        platformUserId,
        invitation.role,
        invitation.full_name,
        invitation.email,
        defaultLocationId,
        JSON.stringify(invitation.permissions ?? {}),
      ],
    );
    const userId = member[0].id;

    if (invitation.location_ids?.length) {
      await client.query(
        "INSERT INTO user_locations (user_id, location_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
        [userId, invitation.location_ids],
      );
    }

    await client.query(
      "UPDATE invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1",
      [invitation.id, userId],
    );

    await client.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'team.invitation_accepted', 'user', $3, $4)`,
      [
        invitation.business_id,
        userId,
        // Separate parameter from user_id above: entity_id is text and user_id
        // is uuid, and Postgres cannot deduce one type for a shared parameter.
        userId,
        JSON.stringify({ invitationId: invitation.id }),
      ],
    );

    await client.query("COMMIT");
    return {
      businessId: invitation.business_id,
      businessSlug: invitation.business_slug,
      businessSubdomain: invitation.business_subdomain,
      userId,
      platformUserId,
      role: invitation.role,
      fullName: invitation.full_name,
      locationId: defaultLocationId,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
