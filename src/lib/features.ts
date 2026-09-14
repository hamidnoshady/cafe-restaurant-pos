/**
 * Phase 17 — feature-flag enforcement.
 *
 * Phase 15 built the write side: `feature_flags` (the catalogue) and
 * `business_features` (per-business overrides) in migration 0020, plus
 * `listFeatureFlags`/`businessFeatures`/`setBusinessFeature` in
 * platform-service.ts and the platform console page to toggle them. None of
 * it was ever read outside that admin path — a disabled flag was
 * administrable but had no effect on the business itself. This is the read
 * side: `withTenantScope` (auth.ts) checks `featureForApiPath` on every API
 * request, and each gated dashboard page calls `requireFeatureForPage`, so a
 * disabled feature is refused at the guard rather than merely left off the
 * nav.
 */
import { redirect } from "next/navigation";
import { query, withTenant } from "./db";

/**
 * Every flag this business has, with its per-business override resolved
 * against the catalogue default.
 *
 * The read is wrapped in `withTenant(businessId, …)` rather than trusting the
 * ambient scope, and that is load-bearing rather than belt-and-braces:
 * `business_features` is RLS-protected (migration 0021) while `feature_flags`
 * is not, so a read that runs *unscoped* still returns the catalogue but
 * silently loses every override — `LEFT JOIN` turning them into NULL, which
 * this function then resolves to `default_enabled`.
 *
 * That is exactly what happened on gated **pages**. A route handler is wrapped
 * in `withTenantScope` (auth.ts) and holds its scope through `run()`, but a
 * server component only has the `enterWith()` scope `getSession()` sets, and
 * that is lost the moment any concurrent `run()` — a background tick in
 * server.ts, the dashboard layout's own `withTenant` call, which renders
 * alongside the page — interleaves. The failure was invisible for every
 * default-ON flag, since losing the override lands on "enabled" anyway, and
 * bit exactly the two default-OFF ones: a business entitled to `ai_assistant`
 * or `integrations` saw the nav entry (the layout scopes its read) and was
 * then redirected away from the page (this one had not been). Naming the
 * business here makes the answer independent of what else is in flight.
 */
export async function effectiveFeatures(
  businessId: string,
): Promise<Record<string, boolean>> {
  const { rows } = await withTenant(businessId, () =>
    query<{ key: string; default_enabled: boolean; override: boolean | null }>(
      `SELECT f.key, f.default_enabled, bf.enabled AS override
         FROM feature_flags f
         LEFT JOIN business_features bf ON bf.flag_key = f.key AND bf.business_id = $1
        ORDER BY f.key`,
      [businessId],
    ),
  );
  return Object.fromEntries(
    rows.map((r) => [r.key, r.override ?? r.default_enabled]),
  );
}

export async function isFeatureEnabled(
  businessId: string,
  flagKey: string,
): Promise<boolean> {
  const features = await effectiveFeatures(businessId);
  // A key with no matching feature_flags row fails open: every prefix below
  // is expected to name a real flag, so this only matters if that mapping
  // itself has a typo — not a business's entitlement to lose over a bug.
  return features[flagKey] ?? true;
}

/**
 * API route prefix -> the flag that gates it. Deliberately excludes
 * `/api/locations` (just `/active`, core branch-resolution plumbing every
 * session needs regardless of any feature) and `/api/rollup/ingest`
 * (server-to-server, bearer-token authenticated, never carries a session —
 * see PUBLIC_PATHS in middleware.ts).
 */
const API_FEATURE_PREFIXES: [string, string][] = [
  ["/api/inventory", "inventory"],
  ["/api/ledger", "ledger"],
  ["/api/reservations", "reservations"],
  ["/api/tables", "reservations"],
  ["/api/table-sessions", "reservations"],
  ["/api/floor", "reservations"],
  ["/api/deliveries", "delivery"],
  ["/api/couriers", "delivery"],
  ["/api/reports", "reporting"],
  ["/api/branches", "multi_location"],
  ["/api/rollup", "offline_mode"],
  ["/api/server-sync", "offline_mode"],
  ["/api/backup", "backup"],
  ["/api/ai", "ai_assistant"],
  ["/api/integrations", "integrations"],
];

export function featureForApiPath(pathname: string): string | null {
  for (const [prefix, flag] of API_FEATURE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return flag;
  }
  return null;
}

/**
 * Canonical workspaces whose server page owns its industry/module gate.
 *
 * They must be checked before the broad `/accounting` ledger prefix below:
 * applying `ledger` to inventory, POS, products, cosmetics or kitchen would
 * make a retail business pass the wrong entitlement check before its own
 * adapter and module guard get a chance to run.
 */
const INDUSTRY_GUARDED_ACCOUNTING_PREFIXES = [
  "/accounting/pos",
  "/accounting/inventory",
  "/accounting/products",
  "/accounting/cosmetics",
  "/accounting/kitchen",
] as const;

/** Dashboard page prefix -> the flag that gates it, for the nav list and each gated page's own redirect. */
export const PAGE_FEATURE_PREFIXES: [string, string][] = [
  // The public work areas inside Accounting. Inventory is special: its page
  // chooses the food-service inventory entitlement or the retail stock model
  // from the industry profile, so it guards that choice server-side rather
  // than falsely applying the food-only flag to retail.
  ["/accounting/reservations", "reservations"],
  ["/accounting/floor", "reservations"],
  ["/dashboard/waiter", "reservations"],
  ["/accounting/delivery", "delivery"],
  ["/accounting/reports", "reporting"],
  // The Accounting app's own ledger prefix; old `/dashboard/accounting` and
  // `/dashboard/ledger` bookmarks still forward here before any page renders.
  ["/accounting", "ledger"],
  ["/dashboard/accounting", "ledger"],
  ["/dashboard/ledger", "ledger"],
  ["/dashboard/branches", "multi_location"],
  ["/dashboard/locations", "offline_mode"],
  ["/dashboard/backup", "backup"],
  ["/dashboard/ai", "ai_assistant"],
  // The legacy `/dashboard/integrations` route redirects to the «اتصال‌های فنی»
  // hub's «وردپرس و ووکامرس» tab; the WordPress/WooCommerce manager is a
  // manager *inside* «مدیریت وب‌سایت» and lives under its prefix. Both halves
  // stay entitlement-gated — an unentitled business lands on a locked preview,
  // not a dead end — while `/dashboard/website` itself (the app home and the
  // Eshobe CMS manager) is not, so a business without `integrations` still
  // reaches its platform site.
  ["/dashboard/integrations", "integrations"],
  // «مدیریت وب‌سایت»'s WordPress manager, at the app's public prefix and at
  // the legacy one it forwards from.
  ["/websites/wp", "integrations"],
  ["/dashboard/website/wp", "integrations"],
  ["/settings/connections/holoo", "integrations"],
  // `/settings/connections` is deliberately absent: the technical hub carries
  // connections with different entitlements (and desktop with none), so it
  // gates each tab rather than the page. See src/lib/connection-kinds.ts.
];

export function featureForPagePath(pathname: string): string | null {
  if (
    INDUSTRY_GUARDED_ACCOUNTING_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  ) {
    return null;
  }
  for (const [prefix, flag] of PAGE_FEATURE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return flag;
  }
  return null;
}

/**
 * Features a business that is *not* entitled to them still gets to look at.
 *
 * The rest of the catalogue is all-or-nothing: a business without `inventory`
 * has no use for an anbar page it can only stare at, so its page redirects and
 * its nav entry is not rendered at all. These two are the sales-facing ones —
 * they are the reason a business would ask to be upgraded — so hiding them
 * makes the product look like it does not have the capability, rather than
 * like the capability is available and switched off. They render instead as a
 * read-only preview: the real screen, visible, with every control inert and a
 * banner saying how to switch it on (`FeatureLock`, src/components/feature-lock.tsx).
 *
 * "Locked" is a UI affordance and nothing more. The API enforcement is
 * unchanged and unconditional — `withTenantScope` still refuses `/api/ai/*`
 * and `/api/integrations/*` with `feature_disabled` — so a preview cannot be
 * turned into a working feature from the browser.
 */
const LOCKABLE_FEATURES = new Set(["ai_assistant", "integrations"]);

export function isLockableFeature(flagKey: string): boolean {
  return LOCKABLE_FEATURES.has(flagKey);
}

/** Called from a gated dashboard page's server component; redirects away if the feature is off for this business. */
export async function requireFeatureForPage(
  businessId: string,
  flagKey: string,
): Promise<void> {
  if (!(await isFeatureEnabled(businessId, flagKey))) redirect("/dashboard");
}

/**
 * `requireFeatureForPage` for a lockable feature: returns whether the page
 * should render its read-only preview instead of its working self.
 *
 * A flag that is not lockable keeps the redirect, so this stays a per-feature
 * decision made in one place rather than something each page invents.
 */
export async function featureLockedForPage(
  businessId: string,
  flagKey: string,
): Promise<boolean> {
  if (await isFeatureEnabled(businessId, flagKey)) return false;
  if (!isLockableFeature(flagKey)) redirect("/dashboard");
  return true;
}
