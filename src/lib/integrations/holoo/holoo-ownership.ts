/**
 * Phase 26 (issue #125) Wave 7 — Holoo ownership.
 *
 * Rows the mirror pulled from Holoo are owned by Holoo; editing them from this
 * app would fork the books away from Holoo. Ownership is answered from the
 * existing `integration_mappings` (no `source_system` column on any core
 * table), and enforced by **one** guard in `withTenantScope` (auth.ts), right
 * beside `featureForApiPath`/`moduleForApiPath`. No CRUD route is edited.
 *
 * The mapping here is "API path prefix → which mapping entity type owns rows
 * under it", in the same style as `API_MODULE_PREFIXES`. When the companion
 * flag is off the guard short-circuits before any of this runs.
 */
import { query } from "../../db";

/** [path prefix, mapping entity type] — the entity type whose rows the prefix mutates. */
export const HOLOO_GUARDED_PREFIXES: readonly (readonly [string, string])[] = [
  ["/api/customers", "holoo_customer"],
  ["/api/ledger/accounts", "holoo_account"],
  ["/api/menu/items", "holoo_goods"],
  ["/api/inventory/items", "holoo_goods"],
  ["/api/inventory/suppliers", "holoo_customer"],
  ["/api/industry/items", "holoo_goods"],
  ["/api/accessories/items", "holoo_goods"],
  ["/api/cosmetics/items", "holoo_goods"],
  ["/api/jewelry/items", "holoo_goods"],
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ownership entity type for a mutating request path, or null. */
export function holooGuardedEntityType(pathname: string): string | null {
  for (const [prefix, entityType] of HOLOO_GUARDED_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return entityType;
  }
  return null;
}

/** The entity id a single-row route addresses (the UUID segment after the prefix), or null. */
export function holooLocalIdFromPath(pathname: string, prefix: string): string | null {
  const rest = pathname.slice(prefix.length).replace(/^\/+/, "");
  const segment = rest.split("/")[0];
  return UUID_RE.test(segment) ? segment : null;
}

/** The subset of `localIds` that are owned by Holoo (present in the mappings). */
export async function holooOwnedIds(
  businessId: string,
  entityType: string,
  localIds: readonly string[],
): Promise<Set<string>> {
  if (localIds.length === 0) return new Set();
  const { rows } = await query<{ local_id: string }>(
    `SELECT local_id FROM integration_mappings
      WHERE business_id = $1 AND entity_type = $2 AND local_id = ANY($3::uuid[])`,
    [businessId, entityType, localIds],
  );
  return new Set(rows.map((r) => r.local_id));
}
