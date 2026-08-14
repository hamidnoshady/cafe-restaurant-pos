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
 * they lean on (capability presets, impersonation clamping) live in
 * `platform-admin.ts` and are tested there, and the guard/isolation behaviour
 * is exercised by the platform integration test.
 */
import { getPool, query, withoutTenantScope } from "./db";
import type { PoolClient } from "pg";
import { disableFeatures, seedChartOfAccounts } from "./business-provisioning";
import type { Industry } from "./industries";
import { industryProfile } from "./industry-profile";
import { clampImpersonationMinutes } from "./platform-admin";
import { SETTING_KEYS } from "./settings";
import type { AppUpdateStatus } from "./app-update";

// ---------------------------------------------------------------------------
// Business lifecycle
// ---------------------------------------------------------------------------

export type BusinessStatus = "active" | "suspended" | "archived";

export interface BusinessSummary {
  id: string;
  name: string;
  slug: string;
  /** Phase 23 — the public host label; mutable, unlike slug. */
  subdomain: string;
  status: BusinessStatus;
  plan: string;
  timezone: string;
  /** Phase 21's `businesses.industry` — which module set, labels and sales model this tenant gets. */
  industry: Industry;
  createdAt: string;
  suspendedAt: string | null;
  archivedAt: string | null;
  locationCount: number;
  memberCount: number;
}

interface BusinessRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  subdomain: string;
  status: BusinessStatus;
  plan: string;
  timezone: string;
  industry: Industry;
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
    subdomain: row.subdomain,
    status: row.status,
    plan: row.plan,
    timezone: row.timezone,
    industry: row.industry,
    createdAt: row.created_at,
    suspendedAt: row.suspended_at,
    archivedAt: row.archived_at,
    locationCount: Number(row.location_count),
    memberCount: Number(row.member_count),
  };
}

/** Every business on the deployment, newest first — the console's landing list. */
export async function listBusinesses(): Promise<BusinessSummary[]> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<BusinessRow>(
      `SELECT b.id, b.name, b.slug::text AS slug, b.subdomain::text AS subdomain,
              b.status::text AS status, b.plan,
              b.timezone, b.industry, b.created_at, b.suspended_at, b.archived_at,
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
      `SELECT b.id, b.name, b.slug::text AS slug, b.subdomain::text AS subdomain,
              b.status::text AS status, b.plan,
              b.timezone, b.industry, b.created_at, b.suspended_at, b.archived_at,
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

/**
 * Editable business metadata. Slug deliberately stays immutable here: it is the
 * stable support identifier shown by the platform console, while name and
 * timezone are ordinary business preferences. The *subdomain* is mutable but
 * not through this function — renaming an origin has consequences (an alias to
 * write, sessions to invalidate) that a generic field setter would hide, so it
 * has its own operation below.
 */
export interface BusinessUpdate {
  name?: string;
  timezone?: string;
}

export type RenameSubdomainResult =
  | { ok: true; business: BusinessSummary; previous: string }
  | { ok: false; error: "not_found" | "subdomain_taken" | "unchanged" };

/**
 * Move a business to a new public host, keeping the old one working.
 *
 * Three things have to happen together or not at all, which is why this is one
 * transaction rather than a column update:
 *
 *  1. the new subdomain is claimed (the unique index is what makes the race
 *     safe — two admins renaming onto the same label cannot both win);
 *  2. the old subdomain becomes an alias, so bookmarks and printed URLs
 *     pointing at it still resolve — `src/app/page.tsx` redirects them to the
 *     current host;
 *  3. any alias equal to the *new* name is dropped, because a label cannot be
 *     both a live subdomain and an alias — the resolver checks businesses
 *     first, so a leftover row would simply be dead weight, and the unique
 *     index would block a future rename back.
 *
 * Existing sessions on the old host are not migrated and cannot be: the JWT
 * carries the old `businessSubdomain`, so middleware sees a mismatch and sends
 * those browsers back to log in. That is the correct outcome — it is the same
 * check that keeps one tenant's cookie off another tenant's origin — and the
 * console warns about it before the rename.
 */
export async function renameBusinessSubdomain(
  businessId: string,
  subdomain: string,
): Promise<RenameSubdomainResult> {
  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<{ subdomain: string }>(
        `SELECT subdomain::text AS subdomain FROM businesses WHERE id = $1 FOR UPDATE`,
        [businessId],
      );
      const previous = rows[0]?.subdomain;
      if (!previous) {
        await client.query("ROLLBACK");
        return { ok: false, error: "not_found" as const };
      }
      if (previous.toLowerCase() === subdomain.toLowerCase()) {
        await client.query("ROLLBACK");
        return { ok: false, error: "unchanged" as const };
      }

      const taken = await client.query(
        `SELECT 1 FROM businesses WHERE subdomain = $1 AND id <> $2
          UNION ALL
         SELECT 1 FROM business_subdomain_aliases WHERE alias = $1 AND business_id <> $2`,
        [subdomain, businessId],
      );
      if (taken.rowCount) {
        await client.query("ROLLBACK");
        return { ok: false, error: "subdomain_taken" as const };
      }

      await client.query(`DELETE FROM business_subdomain_aliases WHERE alias = $1`, [subdomain]);
      await client.query(
        `UPDATE businesses SET subdomain = $2, updated_at = now() WHERE id = $1`,
        [businessId, subdomain],
      );
      await client.query(
        `INSERT INTO business_subdomain_aliases (business_id, alias) VALUES ($1, $2)
         ON CONFLICT (alias) DO NOTHING`,
        [businessId, previous],
      );

      await client.query("COMMIT");
      const business = await getBusiness(businessId);
      return business ? { ok: true as const, business, previous } : { ok: false as const, error: "not_found" as const };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/** Update the editable metadata for one business and return its fresh summary. */
export async function updateBusiness(
  businessId: string,
  values: BusinessUpdate,
): Promise<BusinessSummary | null> {
  const assignments: string[] = [];
  const params: unknown[] = [businessId];

  if (values.name !== undefined) {
    params.push(values.name);
    assignments.push(`name = $${params.length}`);
  }
  if (values.timezone !== undefined) {
    params.push(values.timezone);
    assignments.push(`timezone = $${params.length}`);
  }
  if (assignments.length === 0) return getBusiness(businessId);

  assignments.push("updated_at = now()");
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ id: string }>(
      `UPDATE businesses
          SET ${assignments.join(", ")}
        WHERE id = $1
        RETURNING id`,
      params,
    ),
  );
  return rows[0] ? getBusiness(businessId) : null;
}

/**
 * How much industry-shaped data a business already holds — what the console
 * shows an admin *before* they change its industry, so the warning is a fact
 * rather than a generic scare. Cheap counts, all cross-tenant reads a platform
 * session is entitled to.
 */
export interface IndustryDataCounts {
  /** F&B catalogue rows (`menu_items`), meaningless to a retail industry. */
  menuItems: number;
  /** Phase 21 generic items (`items`), meaningless to F&B. */
  industryItems: number;
  /** Sales already recorded as orders. */
  orders: number;
  /** Journal entries already posted against this business's chart of accounts. */
  journalEntries: number;
}

export async function industryDataCounts(businessId: string): Promise<IndustryDataCounts> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      menu_items: string;
      industry_items: string;
      orders: string;
      journal_entries: string;
    }>(
      `SELECT (SELECT count(*) FROM menu_items m
                 JOIN locations l ON l.id = m.location_id WHERE l.business_id = $1) AS menu_items,
              (SELECT count(*) FROM items i
                 JOIN locations l ON l.id = i.location_id WHERE l.business_id = $1) AS industry_items,
              (SELECT count(*) FROM orders o
                 JOIN locations l ON l.id = o.location_id WHERE l.business_id = $1) AS orders,
              (SELECT count(*) FROM journal_entries j WHERE j.business_id = $1) AS journal_entries`,
      [businessId],
    );
    const row = rows[0];
    return {
      menuItems: Number(row?.menu_items ?? 0),
      industryItems: Number(row?.industry_items ?? 0),
      orders: Number(row?.orders ?? 0),
      journalEntries: Number(row?.journal_entries ?? 0),
    };
  });
}

/**
 * Change which industry a business operates in, and top up its chart of
 * accounts so the new industry's posting rules have the accounts they need.
 *
 * Migration 0048 originally made `industry` immutable *by omission* — no update
 * route existed — because the chart of accounts is seeded from it at creation
 * and there was no way to reconcile a switch. This is the deliberate reversal
 * of that (Phase 25 Wave 1, issue #234): an operator who mis-provisioned a
 * tenant, or a shop that genuinely changes trade, should not need a factory
 * reset.
 *
 * What it is careful *not* to do is rewrite history. Seeding is additive —
 * `seedChartOfAccounts` skips every code the business already has — so existing
 * accounts, their names, and every journal entry posted against them survive
 * untouched. Data belonging to the old industry's model (`menu_items` for an
 * ex-F&B business, `items` for an ex-retail one) is likewise left alone: it
 * simply stops being reachable from the new industry's UI. Reconciling it is
 * the operator's call, which is why `industryDataCounts` exists to tell them
 * what they are leaving behind before they confirm.
 */
export async function changeBusinessIndustry(
  businessId: string,
  industry: Industry,
): Promise<{ business: BusinessSummary; seededAccountCodes: string[] } | null> {
  const seededAccountCodes = await withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows: previous } = await client.query<{ industry: Industry }>(
        `SELECT industry FROM businesses WHERE id = $1 FOR UPDATE`,
        [businessId],
      );
      if (!previous[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `UPDATE businesses SET industry = $2, updated_at = now() WHERE id = $1`,
        [businessId, industry],
      );
      const seeded = await seedChartOfAccounts(client, businessId, industry);

      // Move the feature overrides across too, in both directions. Seeding the
      // new industry's defaults alone would leave a business switched *to*
      // food_service with no tables and no menu, because the overrides its old
      // trade seeded would still be sitting there switched off — so first clear
      // the ones the old industry turned off and the new one has no opinion
      // about. This can undo an operator's own manual "off" for one of those
      // flags; the console is where they turn it back off, and that is a better
      // failure than a café that silently has no floor plan.
      const stale = industryProfile(previous[0].industry).defaultDisabledFeatures.filter(
        (flag) => !industryProfile(industry).defaultDisabledFeatures.includes(flag),
      );
      if (stale.length > 0) {
        await client.query(
          `DELETE FROM business_features WHERE business_id = $1 AND flag_key = ANY($2)`,
          [businessId, stale],
        );
      }
      await disableFeatures(client, businessId, industryProfile(industry).defaultDisabledFeatures);

      await client.query("COMMIT");
      return seeded;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
  if (seededAccountCodes === null) return null;

  const business = await getBusiness(businessId);
  return business ? { business, seededAccountCodes } : null;
}

/**
 * A reset preserves the tenant's stable identity (id, slug, plan and timezone)
 * plus one active owner identity, but removes every tenant-owned row by
 * deleting and recreating the business in one transaction. Cascade handles
 * ordinary tenant records; the deliberately restrictive accounting and inventory
 * records are cleared first in one auditable, transaction-scoped helper.
 *
 * The recreated tenant begins with exactly one blank primary branch and owner
 * membership. It has no settings, chart of accounts, users, feature overrides
 * or operational data, so the owner returns to the initial setup wizard.
 */
export class ResetBusinessNotPossibleError extends Error {
  constructor() {
    super("reset_not_possible");
  }
}

const RESET_DEFAULT_LOCATION_NAME = "شعبه مرکزی";

/**
 * Removes the rows that intentionally use RESTRICT or immutable delete guards
 * before deleting a business root. The caller has already confirmed the
 * destructive action and opened a transaction; every statement is scoped to
 * the one locked business and the transaction rolls back as a unit on error.
 */
async function clearBusinessDeleteBlockers(client: PoolClient, businessId: string): Promise<void> {
  // The migration-only escape hatch is transaction-local. It lets the
  // explicitly confirmed factory reset pass accounting immutability guards,
  // while ordinary edits and deletes keep their existing protections.
  await client.query("SELECT set_config('app.factory_reset', 'true', true)");

  // Child writes take a key-share lock on their location. Lock the current
  // branch set before collecting/deleting data so a concurrent tenant request
  // cannot add a row halfway through this reset.
  await client.query("SELECT id FROM locations WHERE business_id = $1 FOR UPDATE", [businessId]);

  const statements = [
    // Dependent rows first: their foreign keys are deliberately restrictive
    // during normal operation to protect accounting provenance.
    `DELETE FROM inventory_transfer_allocations
       WHERE transfer_line_id IN (
         SELECT line.id
           FROM inventory_transfer_lines line
           JOIN inventory_transfers transfer_row ON transfer_row.id = line.transfer_id
          WHERE transfer_row.business_id = $1
       )`,
    `DELETE FROM inventory_transfer_lines
       WHERE transfer_id IN (SELECT id FROM inventory_transfers WHERE business_id = $1)`,
    `DELETE FROM customer_return_inventory_allocations
       WHERE customer_return_line_id IN (
         SELECT line.id
           FROM customer_return_lines line
           JOIN customer_returns return_row ON return_row.id = line.customer_return_id
          WHERE return_row.business_id = $1
       )`,
    `DELETE FROM customer_return_lines
       WHERE customer_return_id IN (SELECT id FROM customer_returns WHERE business_id = $1)`,
    `DELETE FROM supplier_return_lines
       WHERE supplier_return_id IN (SELECT id FROM supplier_returns WHERE business_id = $1)`,
    `DELETE FROM inventory_write_down_lines
       WHERE write_down_id IN (SELECT id FROM inventory_write_downs WHERE business_id = $1)`,
    `DELETE FROM inventory_cutover_lines
       WHERE cutover_id IN (SELECT id FROM inventory_cutovers WHERE business_id = $1)`,
    `DELETE FROM inventory_history_coverage
       WHERE cutover_id IN (SELECT id FROM inventory_cutovers WHERE business_id = $1)`,
    `DELETE FROM purchase_receipt_cost_allocations
       WHERE inventory_event_id IN (SELECT id FROM inventory_events WHERE business_id = $1)
          OR purchase_item_id IN (
            SELECT item.id
              FROM purchase_items item
              JOIN purchases purchase_row ON purchase_row.id = item.purchase_id
             WHERE purchase_row.location_id IN (SELECT id FROM locations WHERE business_id = $1)
          )`,
    `DELETE FROM inventory_negative_layer_settlements
       WHERE inventory_event_id IN (SELECT id FROM inventory_events WHERE business_id = $1)
          OR purchase_item_id IN (
            SELECT item.id
              FROM purchase_items item
              JOIN purchases purchase_row ON purchase_row.id = item.purchase_id
             WHERE purchase_row.location_id IN (SELECT id FROM locations WHERE business_id = $1)
          )`,
    `DELETE FROM order_item_inventory_snapshots
       WHERE order_item_id IN (
         SELECT item.id
           FROM order_items item
           JOIN orders order_row ON order_row.id = item.order_id
           JOIN locations location_row ON location_row.id = order_row.location_id
          WHERE location_row.business_id = $1
       )`,

    // Remove records that otherwise restrict customers, suppliers, accounts,
    // journal lines, inventory items, or the business root itself.
    "DELETE FROM bank_reconciliations WHERE business_id = $1",
    "DELETE FROM journal_entry_drafts WHERE business_id = $1",
    "DELETE FROM ar_receipts WHERE business_id = $1",
    "DELETE FROM ap_payments WHERE business_id = $1",
    "DELETE FROM expenses WHERE business_id = $1",
    "UPDATE inventory_write_downs SET reversal_of = NULL WHERE business_id = $1",
    "UPDATE inventory_events SET reversal_of = NULL WHERE business_id = $1",
    "DELETE FROM customer_returns WHERE business_id = $1",
    "DELETE FROM supplier_returns WHERE business_id = $1",
    "DELETE FROM inventory_transfers WHERE business_id = $1",
    "DELETE FROM inventory_write_downs WHERE business_id = $1",
    "DELETE FROM inventory_cutovers WHERE business_id = $1",
    "DELETE FROM inventory_negative_layers WHERE business_id = $1",
    "DELETE FROM orders WHERE location_id IN (SELECT id FROM locations WHERE business_id = $1)",
    "DELETE FROM purchases WHERE location_id IN (SELECT id FROM locations WHERE business_id = $1)",
    "DELETE FROM stock_counts WHERE location_id IN (SELECT id FROM locations WHERE business_id = $1)",
    "DELETE FROM journal_entries WHERE business_id = $1",
    "DELETE FROM stock_movements WHERE location_id IN (SELECT id FROM locations WHERE business_id = $1)",
    "DELETE FROM inventory_lots WHERE location_id IN (SELECT id FROM locations WHERE business_id = $1)",
    "DELETE FROM inventory_events WHERE business_id = $1",
  ];

  for (const statement of statements) {
    await client.query(statement, [businessId]);
  }
}

export async function resetBusiness(businessId: string): Promise<void> {
  await withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      const { rows: businessRows } = await client.query<{
        id: string;
        name: string;
        slug: string;
        plan: string;
        timezone: string;
        industry: string;
      }>(
        `SELECT id, name, slug::text AS slug, plan, timezone, industry
           FROM businesses
          WHERE id = $1
          FOR UPDATE`,
        [businessId],
      );
      const business = businessRows[0];
      if (!business) throw new ResetBusinessNotPossibleError();

      // A reset must leave someone who can log in and finish setup. The
      // platform identity is intentionally retained because it may also hold
      // memberships in other businesses; all other memberships are deleted.
      const { rows: ownerRows } = await client.query<{
        platform_user_id: string;
        full_name: string;
        email: string;
      }>(
        `SELECT u.platform_user_id, u.full_name, p.email::text AS email
           FROM users u
           JOIN platform_users p ON p.id = u.platform_user_id
          WHERE u.business_id = $1
            AND u.role = 'owner'
            AND u.is_active
            AND p.is_active
          ORDER BY u.created_at
          LIMIT 1`,
        [businessId],
      );
      const owner = ownerRows[0];
      if (!owner) throw new ResetBusinessNotPossibleError();

      // Most tenant tables cascade from the business root. A small set of
      // accounting/inventory records deliberately uses RESTRICT and immutable
      // delete guards, so clear those reset-only blockers first.
      await clearBusinessDeleteBlockers(client, business.id);
      await client.query(`DELETE FROM businesses WHERE id = $1`, [businessId]);

      await client.query(
        `INSERT INTO businesses
           (id, name, slug, status, plan, timezone, industry, suspended_at, archived_at)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, NULL, NULL)`,
        [business.id, business.name, business.slug, business.plan, business.timezone, business.industry],
      );

      const { rows: locationRows } = await client.query<{ id: string }>(
        `INSERT INTO locations (business_id, name, timezone)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [business.id, RESET_DEFAULT_LOCATION_NAME, business.timezone],
      );
      const locationId = locationRows[0].id;

      const { rows: ownerMembershipRows } = await client.query<{ id: string }>(
        `INSERT INTO users
           (business_id, platform_user_id, role, full_name, email, location_id)
         VALUES ($1, $2, 'owner', $3, $4, NULL)
         RETURNING id`,
        [business.id, owner.platform_user_id, owner.full_name, owner.email],
      );
      const ownerId = ownerMembershipRows[0].id;

      await client.query(
        `INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`,
        [ownerId, locationId],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/** Raised when the target business no longer exists (already deleted, or a bad id). */
export class BusinessNotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}

/**
 * Hard-delete a business, immediately — no archive step, no grace window.
 * The caller must hold `business.delete` (owner-only) and the route requires
 * a fixed confirmation phrase; that pairing is the only safety net left once
 * this is immediate, so both are enforced before this is ever called.
 *
 * Normal tenant records cascade from `businesses(id)`; restrictive
 * accounting/inventory descendants are cleared in the same transaction first.
 * `platform_audit_log.business_id` is `ON DELETE SET NULL`, so the *record
 * that it happened* survives the business it happened to — which is the point.
 *
 * A hard delete is meant to remove *everything*, including the login: any
 * `platform_users` identity whose only membership was in this business is
 * purged along with it, so its email is free to sign up again. An identity
 * still holding a membership in another business is left alone — that's the
 * cross-business-owner case, not an orphan.
 */
export async function hardDeleteBusiness(businessId: string): Promise<void> {
  await withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM businesses WHERE id = $1 FOR UPDATE`,
        [businessId],
      );
      if (!rows[0]) throw new BusinessNotFoundError();

      const { rows: memberIdentities } = await client.query<{ platform_user_id: string }>(
        `SELECT DISTINCT platform_user_id FROM users
          WHERE business_id = $1 AND platform_user_id IS NOT NULL`,
        [businessId],
      );

      await clearBusinessDeleteBlockers(client, businessId);
      await client.query(`DELETE FROM businesses WHERE id = $1`, [businessId]);

      if (memberIdentities.length > 0) {
        await client.query(
          `DELETE FROM platform_users
            WHERE id = ANY($1::uuid[])
              AND NOT EXISTS (SELECT 1 FROM users WHERE users.platform_user_id = platform_users.id)`,
          [memberIdentities.map((row) => row.platform_user_id)],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
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

export interface Plan {
  key: string;
  name: string;
  branchLimit: number | null;
  memberLimit: number | null;
  monthlyOrderLimit: number | null;
}

/** The global plan catalogue (plans is not tenant data, same as feature_flags — see migration 0034). */
export async function listPlans(): Promise<Plan[]> {
  const { rows } = await query<{
    key: string;
    name: string;
    branch_limit: number | null;
    member_limit: number | null;
    monthly_order_limit: number | null;
  }>(`SELECT key, name, branch_limit, member_limit, monthly_order_limit FROM plans ORDER BY key`);
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    branchLimit: r.branch_limit,
    memberLimit: r.member_limit,
    monthlyOrderLimit: r.monthly_order_limit,
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

/** Assign a plan to a business (must be a key from listPlans()). Plans are assigned by hand (no billing). */
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
         (SELECT max(o.opened_at) FROM orders o
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
// Desktop installer update distribution (owner-only to configure)
// ---------------------------------------------------------------------------

export interface UpdateDistributionConfig {
  s3Endpoint: string;
  s3Bucket: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  publicBaseUrl: string;
}

/** Null until an owner has configured it once — the console treats that as "not set up yet", not an error. */
export async function getUpdateDistributionConfig(): Promise<UpdateDistributionConfig | null> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{
      s3_endpoint: string | null;
      s3_bucket: string | null;
      s3_access_key_id: string | null;
      s3_secret_access_key: string | null;
      public_base_url: string | null;
    }>(
      `SELECT s3_endpoint, s3_bucket, s3_access_key_id, s3_secret_access_key, public_base_url
         FROM platform_update_config WHERE id = true`,
    ),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    s3Endpoint: row.s3_endpoint ?? "",
    s3Bucket: row.s3_bucket ?? "",
    s3AccessKeyId: row.s3_access_key_id ?? "",
    s3SecretAccessKey: row.s3_secret_access_key ?? "",
    publicBaseUrl: row.public_base_url ?? "",
  };
}

export async function setUpdateDistributionConfig(config: UpdateDistributionConfig): Promise<void> {
  await withoutTenantScope("platform", () =>
    query(
      `INSERT INTO platform_update_config
         (id, s3_endpoint, s3_bucket, s3_access_key_id, s3_secret_access_key, public_base_url, updated_at)
       VALUES (true, $1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE SET
         s3_endpoint = EXCLUDED.s3_endpoint,
         s3_bucket = EXCLUDED.s3_bucket,
         s3_access_key_id = EXCLUDED.s3_access_key_id,
         s3_secret_access_key = EXCLUDED.s3_secret_access_key,
         public_base_url = EXCLUDED.public_base_url,
         updated_at = now()`,
      [config.s3Endpoint, config.s3Bucket, config.s3AccessKeyId, config.s3SecretAccessKey, config.publicBaseUrl],
    ),
  );
}

export interface ClientVersionStatus {
  businessId: string;
  businessName: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
}

/**
 * Per-business self-update status (AppUpdateStatus, src/lib/app-update.ts —
 * settings key SETTING_KEYS.appUpdateStatus) across every business, so the
 * platform can see at a glance which café installs are current and which
 * have fallen behind.
 *
 * Only covers installs with server-sync configured against this VPS (the
 * Docker on-site path, which is what actually reports a version at all). A
 * fully standalone desktop install with no VPS connection has no channel to
 * report through — it simply won't appear here. That's a real, current gap,
 * not a bug — see docs/standalone-desktop-app.md.
 */
export async function clientVersionCompliance(): Promise<ClientVersionStatus[]> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ business_id: string; business_name: string; value: AppUpdateStatus }>(
      `SELECT s.business_id, b.name AS business_name, s.value
         FROM settings s
         JOIN businesses b ON b.id = s.business_id
        WHERE s.key = $1 AND s.location_id IS NULL
        ORDER BY b.name`,
      [SETTING_KEYS.appUpdateStatus],
    ),
  );
  return rows.map((r) => ({
    businessId: r.business_id,
    businessName: r.business_name,
    currentVersion: r.value.currentVersion,
    latestVersion: r.value.latestVersion,
    updateAvailable: r.value.updateAvailable,
    checkedAt: r.value.checkedAt,
    error: r.value.error,
  }));
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
