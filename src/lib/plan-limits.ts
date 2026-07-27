/**
 * Phase 17 — per-plan ceilings (branches, members, orders/month), enforced at
 * the point of creation.
 *
 * Unlike feature flags (a static path → flag lookup, checked once centrally
 * in `withTenantScope` — see features.ts), a plan limit needs a COUNT(*)
 * specific to the action being taken, so there is no single request-shaped
 * chokepoint to hang this off. Each creation path calls the relevant
 * count/limit pair itself, right before its own INSERT.
 *
 * Every function takes an optional `exec` (defaults to the pool-scoped
 * `query()`, which is correctly tenant-scoped for any call made from within
 * an ordinary request because tenant scope lives in AsyncLocalStorage, not
 * on a particular connection). The one caller that must NOT use the default
 * is `acceptInvitation` (team-service.ts): that route has no session and
 * flips `app.rls_bypass`/`app.business_id` by hand directly on its own
 * `PoolClient`, so its plan-limit check has to run on that same client to
 * see the same GUCs — a fresh pool connection would see no tenant scope at
 * all and RLS would (correctly, but unhelpfully) count zero rows for anyone.
 */
import { query } from "./db";

interface Executor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface PlanLimits {
  key: string;
  name: string;
  /** null = unlimited */
  branchLimit: number | null;
  /** null = unlimited */
  memberLimit: number | null;
  /** null = unlimited */
  monthlyOrderLimit: number | null;
}

export async function planLimitsFor(businessId: string, exec: Executor = { query }): Promise<PlanLimits> {
  const { rows } = await exec.query<{
    key: string;
    name: string;
    branch_limit: number | null;
    member_limit: number | null;
    monthly_order_limit: number | null;
  }>(
    `SELECT p.key, p.name, p.branch_limit, p.member_limit, p.monthly_order_limit
       FROM businesses b JOIN plans p ON p.key = b.plan
      WHERE b.id = $1`,
    [businessId],
  );
  const row = rows[0];
  if (!row) throw new Error(`business_or_plan_not_found: ${businessId}`);
  return {
    key: row.key,
    name: row.name,
    branchLimit: row.branch_limit,
    memberLimit: row.member_limit,
    monthlyOrderLimit: row.monthly_order_limit,
  };
}

/** Resolves a location to the business that owns it — used where only a locationId is on hand (order creation). */
export async function businessIdForLocation(locationId: string, exec: Executor = { query }): Promise<string | null> {
  const { rows } = await exec.query<{ business_id: string }>(
    "SELECT business_id FROM locations WHERE id = $1",
    [locationId],
  );
  return rows[0]?.business_id ?? null;
}

export async function activeBranchCount(businessId: string, exec: Executor = { query }): Promise<number> {
  const { rows } = await exec.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM locations WHERE business_id = $1 AND is_active",
    [businessId],
  );
  return Number(rows[0].count);
}

export async function activeMemberCount(businessId: string, exec: Executor = { query }): Promise<number> {
  const { rows } = await exec.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM users WHERE business_id = $1 AND is_active",
    [businessId],
  );
  return Number(rows[0].count);
}

/** Orders opened since the start of the current calendar month, across every branch of the business. */
export async function monthlyOrderCount(businessId: string, exec: Executor = { query }): Promise<number> {
  const { rows } = await exec.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM orders o JOIN locations l ON l.id = o.location_id
      WHERE l.business_id = $1 AND o.opened_at >= date_trunc('month', now())`,
    [businessId],
  );
  return Number(rows[0].count);
}
