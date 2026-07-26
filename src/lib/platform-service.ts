/**
 * Phase 15 — the read/write operations behind the super-admin console.
 *
 * Everything here runs from a platform request, whose `getPlatformSession`
 * already stood tenant isolation down (bypass scope). These functions are the
 * cross-tenant queries that would be impossible — and are meant to be
 * impossible — from a tenant session: listing every business, reading any
 * business's usage, minting an impersonation session into a business the
 * operator is not a member of.
 *
 * DB-touching, so no direct unit test per repo convention; the pure decisions
 * they lean on (capability presets, grace-window/impersonation clamping) live
 * in `platform-admin.ts` and are tested there, and the guard/isolation
 * behaviour is exercised by the platform integration test.
 */
import { getPool, query, withoutTenantScope } from "./db";
import type { PoolClient } from "pg";
import { clampImpersonationMinutes, isDeleteEligible } from "./platform-admin";

// ---------------------------------------------------------------------------
// Business lifecycle
// ---------------------------------------------------------------------------

export type BusinessStatus = "active" | "suspended" | "archived";

export interface BusinessSummary {
  id: string;
  name: string;
  slug: string;
  status: BusinessStatus;
  plan: string;
  timezone: string;
  createdAt: string;
  suspendedAt: string | null;
  archivedAt: string | null;
  locationCount: number;
  memberCount: number;
  deleteEligible: boolean;
}

interface BusinessRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  status: BusinessStatus;
  plan: string;
  timezone: string;
  created_at: string;
  suspended_at: string | null;
  archived_at: string | null;
  location_count: string;
  member_count: string;
}

function toSummary(row: BusinessRow): BusinessSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    plan: row.plan,
    timezone: row.timezone,
    createdAt: row.created_at,
    suspendedAt: row.suspended_at,
    archivedAt: row.archived_at,
    locationCount: Number(row.location_count),
    memberCount: Number(row.member_count),
    deleteEligible: row.status === "archived" && isDeleteEligible(row.archived_at),
  };
}

/** Every business on the deployment, newest first — the console's landing list. */
export async function listBusinesses(): Promise<BusinessSummary[]> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<BusinessRow>(
      `SELECT b.id, b.name, b.slug::text AS slug, b.status::text AS status, b.plan,
              b.timezone, b.created_at, b.suspended_at, b.archived_at,
              (SELECT count(*) FROM locations l WHERE l.business_id = b.id) AS location_count,
              (SELECT count(*) FROM users u WHERE u.business_id = b.id AND u.is_active) AS member_count
         FROM businesses b
        ORDER BY b.created_at DESC`,
    );
    return rows.map(toSummary);
  });
}

/** One business by id, or null. */
export async function getBusiness(businessId: string): Promise<BusinessSummary | null> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<BusinessRow>(
      `SELECT b.id, b.name, b.slug::text AS slug, b.status::text AS status, b.plan,
              b.timezone, b.created_at, b.suspended_at, b.archived_at,
              (SELECT count(*) FROM locations l WHERE l.business_id = b.id) AS location_count,
              (SELECT count(*) FROM users u WHERE u.business_id = b.id AND u.is_active) AS member_count
         FROM businesses b
        WHERE b.id = $1`,
      [businessId],
    );
    return rows[0] ? toSummary(rows[0]) : null;
  });
}

/**
 * Move a business between lifecycle states.
 *
 * Suspend/reactivate flip `status` and stamp `suspended_at`; the actual
 * blocking happens at login (`membershipBlockedReason`) and at the API guard
 * (`requirePermission` returns `business_suspended`), so no data is touched —
 * the exit criterion is "blocks members without deleting anything". Archiving
 * additionally stamps `archived_at`, which starts the hard-delete grace clock.
 */
export async function setBusinessStatus(
  businessId: string,
  status: BusinessStatus,
): Promise<BusinessSummary | null> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ id: string }>(
      `UPDATE businesses
          SET status = $2::business_status,
              suspended_at = CASE WHEN $2 = 'suspended' THEN now()
                                  WHEN $2 = 'active' THEN NULL
                                  ELSE suspended_at END,
              archived_at  = CASE WHEN $2 = 'archived' THEN now()
                                  WHEN $2 = 'active' THEN NULL
                                  ELSE archived_at END,
              updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [businessId, status],
    ),
  );
  return rows[0] ? getBusiness(businessId) : null;
}

/** Raised when a hard-delete is attempted before the grace window elapses. */
export class DeleteNotEligibleError extends Error {
  constructor() {
    super("delete_not_eligible");
  }
}

/**
 * Hard-delete an archived business, past its grace window.
 *
 * The whole schema hangs off `businesses(id)` with `ON DELETE CASCADE`, so a
 * single delete removes every location, order, ledger entry and membership.
 * `platform_audit_log.business_id` is `ON DELETE SET NULL`, so the *record
 * that it happened* survives the business it happened to — which is the point.
 *
 * Guarded twice: the caller must hold `business.delete`, and the business must
 * be archived past `deleteGraceDays()`. Never immediate (open question 2).
 */
export async function hardDeleteBusiness(businessId: string): Promise<void> {
  const business = await getBusiness(businessId);
  if (!business || !business.deleteEligible) {
    throw new DeleteNotEligibleError();
  }
  await withoutTenantScope("platform", () =>
    query(`DELETE FROM businesses WHERE id = $1`, [businessId]),
  );
}

// ---------------------------------------------------------------------------
// Feature flags & entitlements
// ---------------------------------------------------------------------------

export interface FeatureFlag {
  key: string;
  name: string;
  description: string | null;
  defaultEnabled: boolean;
}

export interface BusinessFeature extends FeatureFlag {
  /** The per-business override, or null when the business follows the default. */
  override: boolean | null;
  /** The value actually in force: override if set, else the flag default. */
  effective: boolean;
}

/** The global flag catalogue (feature_flags is not tenant data — see 0021). */
export async function listFeatureFlags(): Promise<FeatureFlag[]> {
  const { rows } = await query<{
    key: string;
    name: string;
    description: string | null;
    default_enabled: boolean;
  }>(`SELECT key, name, description, default_enabled FROM feature_flags ORDER BY key`);
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    defaultEnabled: r.default_enabled,
  }));
}

/** Every flag, with this business's override and the effective value resolved. */
export async function businessFeatures(businessId: string): Promise<BusinessFeature[]> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{
      key: string;
      name: string;
      description: string | null;
      default_enabled: boolean;
      override: boolean | null;
    }>(
      `SELECT f.key, f.name, f.description, f.default_enabled, bf.enabled AS override
         FROM feature_flags f
         LEFT JOIN business_features bf
           ON bf.flag_key = f.key AND bf.business_id = $1
        ORDER BY f.key`,
      [businessId],
    ),
  );
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    defaultEnabled: r.default_enabled,
    override: r.override,
    effective: r.override ?? r.default_enabled,
  }));
}

/**
 * Set or clear a per-business flag override.
 *
 * `enabled: null` deletes the override so the business falls back to the flag
 * default — the write side of the `business_features` table Phase 12 created,
 * and what Phase 17 will read to gate the UI and the API.
 */
export async function setBusinessFeature(
  businessId: string,
  flagKey: string,
  enabled: boolean | null,
): Promise<void> {
  await withoutTenantScope("platform", async () => {
    if (enabled === null) {
      await query(`DELETE FROM business_features WHERE business_id = $1 AND flag_key = $2`, [
        businessId,
        flagKey,
      ]);
      return;
    }
    await query(
      `INSERT INTO business_features (business_id, flag_key, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (business_id, flag_key)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [businessId, flagKey, enabled],
    );
  });
}

/** Assign a plan label to a business. Plans are assigned by hand (no billing). */
export async function setBusinessPlan(businessId: string, plan: string): Promise<void> {
  await withoutTenantScope("platform", () =>
    query(`UPDATE businesses SET plan = $2, updated_at = now() WHERE id = $1`, [businessId, plan]),
  );
}

// ---------------------------------------------------------------------------
// Cross-business usage
// ---------------------------------------------------------------------------

export interface BusinessUsage {
  orders: number;
  openOrders: number;
  members: number;
  locations: number;
  menuItems: number;
  journalEntries: number;
  lastActivity: string | null;
}

/**
 * A business's usage snapshot: volume, membership, and last activity.
 *
 * Counts are per business rather than the whole deployment — the console shows
 * one business's numbers on its detail page. `lastActivity` is the most recent
 * of a few high-signal timestamps, which is enough to tell a live business
 * from a dormant one without a heavy scan.
 */
export async function businessUsage(businessId: string): Promise<BusinessUsage> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{
      orders: string;
      open_orders: string;
      members: string;
      locations: string;
      menu_items: string;
      journal_entries: string;
      last_activity: string | null;
    }>(
      `SELECT
         (SELECT count(*) FROM orders o
            JOIN locations l ON l.id = o.location_id WHERE l.business_id = $1) AS orders,
         (SELECT count(*) FROM orders o
            JOIN locations l ON l.id = o.location_id
           WHERE l.business_id = $1 AND o.status = 'open') AS open_orders,
         (SELECT count(*) FROM users u WHERE u.business_id = $1 AND u.is_active) AS members,
         (SELECT count(*) FROM locations l WHERE l.business_id = $1) AS locations,
         (SELECT count(*) FROM menu_items mi
            JOIN locations l ON l.id = mi.location_id WHERE l.business_id = $1) AS menu_items,
         (SELECT count(*) FROM journal_entries je WHERE je.business_id = $1) AS journal_entries,
         (SELECT max(o.created_at) FROM orders o
            JOIN locations l ON l.id = o.location_id WHERE l.business_id = $1) AS last_activity`,
      [businessId],
    ),
  );
  const r = rows[0];
  return {
    orders: Number(r?.orders ?? 0),
    openOrders: Number(r?.open_orders ?? 0),
    members: Number(r?.members ?? 0),
    locations: Number(r?.locations ?? 0),
    menuItems: Number(r?.menu_items ?? 0),
    journalEntries: Number(r?.journal_entries ?? 0),
    lastActivity: r?.last_activity ?? null,
  };
}

// ---------------------------------------------------------------------------
// Impersonation grants — the consent-and-time-limit trail
// ---------------------------------------------------------------------------

export type ImpersonationMode = "read_only" | "full";

export interface ImpersonationGrant {
  id: string;
  platformAdminId: string;
  businessId: string;
  userId: string | null;
  mode: ImpersonationMode;
  reason: string | null;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  revokedAt: string | null;
}

interface GrantRow extends Record<string, unknown> {
  id: string;
  platform_admin_id: string;
  business_id: string;
  user_id: string | null;
  mode: ImpersonationMode;
  reason: string | null;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
  revoked_at: string | null;
}

function toGrant(row: GrantRow): ImpersonationGrant {
  return {
    id: row.id,
    platformAdminId: row.platform_admin_id,
    businessId: row.business_id,
    userId: row.user_id,
    mode: row.mode,
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    revokedAt: row.revoked_at,
  };
}

export class BusinessNotImpersonableError extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

/**
 * Open an impersonation window into a business and return the grant plus the
 * owner membership the admin will act as.
 *
 * The grant row is written FIRST, in the same transaction that resolves the
 * membership, so a tenant session can never be minted without a durable record
 * naming the admin, the business, the mode and the window. That ordering is
 * the whole point: impersonation is impossible without leaving an audit record
 * (an exit criterion).
 *
 * The admin acts as an existing *owner* membership of the business, so every
 * tagged action is attributable to a real seat rather than a synthetic one.
 * An archived business cannot be entered; a suspended one can (support often
 * needs to look precisely because it is suspended).
 */
export async function startImpersonation(params: {
  adminId: string;
  businessId: string;
  mode: ImpersonationMode;
  reason?: string | null;
  minutes?: number;
}): Promise<{ grant: ImpersonationGrant; userId: string; fullName: string }> {
  const minutes = clampImpersonationMinutes(params.minutes);

  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      const { rows: bizRows } = await client.query<{ status: BusinessStatus }>(
        `SELECT status::text AS status FROM businesses WHERE id = $1`,
        [params.businessId],
      );
      if (!bizRows[0]) throw new BusinessNotImpersonableError("business_not_found");
      if (bizRows[0].status === "archived") {
        throw new BusinessNotImpersonableError("business_archived");
      }

      // Act as the oldest active owner of the business — a real membership, so
      // the acting user_id resolves to someone accountable inside the tenant.
      const { rows: ownerRows } = await client.query<{ id: string; full_name: string }>(
        `SELECT id, full_name FROM users
          WHERE business_id = $1 AND role = 'owner' AND is_active
          ORDER BY created_at LIMIT 1`,
        [params.businessId],
      );
      if (!ownerRows[0]) throw new BusinessNotImpersonableError("no_owner");

      const { rows: grantRows } = await client.query<GrantRow>(
        `INSERT INTO impersonation_grants
           (platform_admin_id, business_id, user_id, mode, reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval)
         RETURNING id, platform_admin_id, business_id, user_id, mode, reason,
                   created_at, expires_at, ended_at, revoked_at`,
        [
          params.adminId,
          params.businessId,
          ownerRows[0].id,
          params.mode,
          params.reason?.trim() || null,
          String(minutes),
        ],
      );

      await client.query("COMMIT");
      return {
        grant: toGrant(grantRows[0]),
        userId: ownerRows[0].id,
        fullName: ownerRows[0].full_name,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * The live grant for an (admin, business) pair right now, or null.
 *
 * "Live" = created, not ended, not revoked, not expired. This is the check the
 * impersonation guard runs on every request carrying an impersonation claim:
 * the tenant token alone is never trusted; the grant must still be open in the
 * database, so ending or revoking a window takes effect on the next request.
 */
export async function activeGrant(
  adminId: string,
  businessId: string,
): Promise<ImpersonationGrant | null> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<GrantRow>(
      `SELECT id, platform_admin_id, business_id, user_id, mode, reason,
              created_at, expires_at, ended_at, revoked_at
         FROM impersonation_grants
        WHERE platform_admin_id = $1 AND business_id = $2
          AND ended_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [adminId, businessId],
    ),
  );
  return rows[0] ? toGrant(rows[0]) : null;
}

/** The admin ends their own window (they left the business). */
export async function endImpersonation(grantId: string, adminId: string): Promise<void> {
  await withoutTenantScope("platform", () =>
    query(
      `UPDATE impersonation_grants
          SET ended_at = now()
        WHERE id = $1 AND platform_admin_id = $2 AND ended_at IS NULL AND revoked_at IS NULL`,
      [grantId, adminId],
    ),
  );
}

/** A different admin pulls the plug on a live grant (kill switch). */
export async function revokeImpersonation(grantId: string, revokedBy: string): Promise<void> {
  await withoutTenantScope("platform", () =>
    query(
      `UPDATE impersonation_grants
          SET revoked_at = now(), revoked_by = $2
        WHERE id = $1 AND ended_at IS NULL AND revoked_at IS NULL`,
      [grantId, revokedBy],
    ),
  );
}

/** Recent impersonation grants across the platform, or scoped to one business. */
export async function listGrants(businessId?: string): Promise<ImpersonationGrant[]> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<GrantRow>(
      `SELECT id, platform_admin_id, business_id, user_id, mode, reason,
              created_at, expires_at, ended_at, revoked_at
         FROM impersonation_grants
        WHERE ($1::uuid IS NULL OR business_id = $1)
        ORDER BY created_at DESC LIMIT 100`,
      [businessId ?? null],
    ),
  );
  return rows.map(toGrant);
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  platformAdminId: string | null;
  adminName: string | null;
  businessId: string | null;
  businessName: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  payload: unknown;
  createdAt: string;
}

/** The platform audit log, newest first, optionally scoped to one business. */
export async function listAudit(businessId?: string, limit = 200): Promise<AuditEntry[]> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{
      id: string;
      platform_admin_id: string | null;
      admin_name: string | null;
      business_id: string | null;
      business_name: string | null;
      action: string;
      entity: string | null;
      entity_id: string | null;
      payload: unknown;
      created_at: string;
    }>(
      `SELECT al.id::text AS id, al.platform_admin_id, pa.full_name AS admin_name,
              al.business_id, b.name AS business_name, al.action, al.entity,
              al.entity_id, al.payload, al.created_at
         FROM platform_audit_log al
         LEFT JOIN platform_admins pa ON pa.id = al.platform_admin_id
         LEFT JOIN businesses b ON b.id = al.business_id
        WHERE ($1::uuid IS NULL OR al.business_id = $1)
        ORDER BY al.created_at DESC
        LIMIT $2`,
      [businessId ?? null, limit],
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    platformAdminId: r.platform_admin_id,
    adminName: r.admin_name,
    businessId: r.business_id,
    businessName: r.business_name,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    payload: r.payload,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// System management
// ---------------------------------------------------------------------------

export interface SystemStatus {
  migrations: { filename: string; appliedAt: string }[];
  pendingMigrations: number;
  pool: { total: number; idle: number; waiting: number };
  rlsEffective: boolean;
  backups: { businessId: string; businessName: string; status: string; ranAt: string | null }[];
  counts: { businesses: number; platformUsers: number; platformAdmins: number };
}

/**
 * A snapshot of platform health for the system page: applied migrations, the
 * connection pool's live figures, whether RLS is actually being enforced, and
 * the most recent backup run per business. Read-only and cheap — this is a
 * dashboard, not a control surface.
 */
export async function systemStatus(pendingMigrations: number): Promise<SystemStatus> {
  const pool = getPool();

  const [migrations, backups, counts, rls] = await withoutTenantScope("platform", () =>
    Promise.all([
      query<{ filename: string; applied_at: string }>(
        `SELECT filename, applied_at FROM schema_migrations ORDER BY filename DESC LIMIT 30`,
      ),
      query<{ business_id: string; business_name: string; status: string; ran_at: string | null }>(
        `SELECT DISTINCT ON (br.business_id)
                br.business_id, b.name AS business_name, br.status, br.started_at AS ran_at
           FROM backup_runs br
           JOIN businesses b ON b.id = br.business_id
          ORDER BY br.business_id, br.started_at DESC`,
      ),
      query<{ businesses: string; platform_users: string; platform_admins: string }>(
        `SELECT (SELECT count(*) FROM businesses) AS businesses,
                (SELECT count(*) FROM platform_users) AS platform_users,
                (SELECT count(*) FROM platform_admins) AS platform_admins`,
      ),
      query<{ privileged: boolean }>(
        `SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user`,
      ),
    ]),
  );

  return {
    migrations: migrations.rows.map((m) => ({ filename: m.filename, appliedAt: m.applied_at })),
    pendingMigrations,
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    },
    rlsEffective: rls.rows[0] ? !rls.rows[0].privileged : false,
    backups: backups.rows.map((b) => ({
      businessId: b.business_id,
      businessName: b.business_name,
      status: b.status,
      ranAt: b.ran_at,
    })),
    counts: {
      businesses: Number(counts.rows[0]?.businesses ?? 0),
      platformUsers: Number(counts.rows[0]?.platform_users ?? 0),
      platformAdmins: Number(counts.rows[0]?.platform_admins ?? 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Platform admin management (owner-only)
// ---------------------------------------------------------------------------

export interface PlatformAdminSummary {
  id: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export async function listPlatformAdmins(): Promise<PlatformAdminSummary[]> {
  const { rows } = await query<{
    id: string;
    email: string;
    full_name: string;
    role: string;
    is_active: boolean;
    last_login_at: string | null;
    created_at: string;
  }>(
    `SELECT id, email::text AS email, full_name, role::text AS role,
            is_active, last_login_at, created_at
       FROM platform_admins ORDER BY created_at`,
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    role: r.role,
    isActive: r.is_active,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  }));
}

/** Suppress unused-import lint: PoolClient is referenced only in a type slot. */
export type { PoolClient };
