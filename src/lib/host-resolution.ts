/**
 * The Node-runtime half of host resolution: turning a hostname into the
 * business it addresses.
 *
 * This cannot live in `host.ts` with the parsing, because it needs the
 * database and `src/middleware.ts` runs on Edge. The split is the same one
 * `auth-edge.ts`/`auth.ts` makes, and for the same reason.
 */
import { query, withoutTenantScope } from "./db";
import { parseHost } from "./host";

export interface ResolvedBusinessHost {
  businessId: string;
  name: string;
  /** The business's *current* subdomain, which may differ from the one asked for. */
  subdomain: string;
  status: "active" | "suspended" | "archived";
  /** True when the request arrived on an old host that has since been renamed. */
  viaAlias: boolean;
}

/**
 * Resolve a subdomain label to its business, following one rename if needed.
 *
 * Bypassed for the same reason resolving a login email to its memberships is:
 * the host is *how* a tenant gets identified, so there is no tenant to scope
 * to yet. This is a seventh entry in `withoutTenantScope`'s list of justified
 * holes and is the same shape as the others — a single, read-only lookup whose
 * whole job is to answer "which business is this request for?".
 *
 * Live subdomains are checked before aliases so a label that has been reused
 * resolves to its current owner rather than to whoever released it. Returns
 * null when the label belongs to nobody.
 */
export async function resolveBusinessByLabel(label: string): Promise<ResolvedBusinessHost | null> {
  if (!label) return null;

  return withoutTenantScope("host-resolution", async () => {
    const direct = await query<{ id: string; name: string; subdomain: string; status: ResolvedBusinessHost["status"] }>(
      `SELECT id, name, subdomain::text AS subdomain, status::text AS status
         FROM businesses WHERE subdomain = $1`,
      [label],
    );
    if (direct.rows[0]) {
      const row = direct.rows[0];
      return { businessId: row.id, name: row.name, subdomain: row.subdomain, status: row.status, viaAlias: false };
    }

    const alias = await query<{ id: string; name: string; subdomain: string; status: ResolvedBusinessHost["status"] }>(
      `SELECT b.id, b.name, b.subdomain::text AS subdomain, b.status::text AS status
         FROM business_subdomain_aliases a
         JOIN businesses b ON b.id = a.business_id
        WHERE a.alias = $1`,
      [label],
    );
    if (alias.rows[0]) {
      const row = alias.rows[0];
      return { businessId: row.id, name: row.name, subdomain: row.subdomain, status: row.status, viaAlias: true };
    }

    return null;
  });
}

/** `parseHost` + the database lookup, for callers that hold a raw Host header. */
export async function resolveHost(
  host: string | null | undefined,
  rootDomain: string | null | undefined,
): Promise<ResolvedBusinessHost | null> {
  const parsed = parseHost(host, rootDomain);
  if (parsed.kind !== "business") return null;
  return resolveBusinessByLabel(parsed.label);
}

/** Every old host still pointing at a business, newest first. */
export async function listSubdomainAliases(businessId: string): Promise<Array<{ alias: string; createdAt: string }>> {
  const { rows } = await query<{ alias: string; created_at: string }>(
    `SELECT alias::text AS alias, created_at
       FROM business_subdomain_aliases
      WHERE business_id = $1
      ORDER BY created_at DESC`,
    [businessId],
  );
  return rows.map((r) => ({ alias: r.alias, createdAt: r.created_at }));
}
