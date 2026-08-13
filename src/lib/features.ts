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
import { query } from "./db";

/** Every flag this business has, with its per-business override resolved against the catalogue default. */
export async function effectiveFeatures(businessId: string): Promise<Record<string, boolean>> {
  const { rows } = await query<{ key: string; default_enabled: boolean; override: boolean | null }>(
    `SELECT f.key, f.default_enabled, bf.enabled AS override
       FROM feature_flags f
       LEFT JOIN business_features bf ON bf.flag_key = f.key AND bf.business_id = $1
      ORDER BY f.key`,
    [businessId],
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.override ?? r.default_enabled]));
}

export async function isFeatureEnabled(businessId: string, flagKey: string): Promise<boolean> {
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

/** Dashboard page prefix -> the flag that gates it, for the nav list and each gated page's own redirect. */
export const PAGE_FEATURE_PREFIXES: [string, string][] = [
  ["/dashboard/inventory", "inventory"],
  ["/dashboard/ledger", "ledger"],
  ["/dashboard/reservations", "reservations"],
  ["/dashboard/floor", "reservations"],
  ["/dashboard/waiter", "reservations"],
  ["/dashboard/delivery", "delivery"],
  ["/dashboard/reports", "reporting"],
  ["/dashboard/branches", "multi_location"],
  ["/dashboard/locations", "offline_mode"],
  ["/dashboard/backup", "backup"],
  ["/dashboard/ai", "ai_assistant"],
  ["/dashboard/integrations", "integrations"],
];

export function featureForPagePath(pathname: string): string | null {
  for (const [prefix, flag] of PAGE_FEATURE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return flag;
  }
  return null;
}

/** Called from a gated dashboard page's server component; redirects away if the feature is off for this business. */
export async function requireFeatureForPage(businessId: string, flagKey: string): Promise<void> {
  if (!(await isFeatureEnabled(businessId, flagKey))) redirect("/dashboard");
}
