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

/**
 * A business by its stable internal slug, for translating a pre-Phase-23
 * `/{slug}/dashboard` URL into the host that serves it now.
 *
 * Slug and subdomain agree for every business migration 0066 backfilled, but
 * they diverge the moment an admin sets a real subdomain — so the old URL
 * cannot simply be reinterpreted as a host label, which is exactly the bug
 * this exists to fix. Same bypass rationale as resolveBusinessByLabel: no
 * tenant has been chosen yet, because identifying it is the whole task.
 */
export async function resolveBusinessBySlug(slug: string): Promise<ResolvedBusinessHost | null> {
  if (!slug) return null;

  return withoutTenantScope("host-resolution", async () => {
    const { rows } = await query<{
      id: string;
      name: string;
      subdomain: string;
      status: ResolvedBusinessHost["status"];
    }>(
      `SELECT id, name, subdomain::text AS subdomain, status::text AS status
         FROM businesses WHERE slug = $1`,
      [slug],
    );
    const row = rows[0];
    return row
      ? { businessId: row.id, name: row.name, subdomain: row.subdomain, status: row.status, viaAlias: false }
      : null;
  });
}

/**
 * The one business on an install that has only one.
 *
 * A deployment with no `ROOT_DOMAIN` — the Electron desktop app, a single-café
 * laptop — has no host label to resolve, so a session-less entrance that must
 * still name a tenant has nothing to ask. There is exactly one business on such
 * an install, and this returns it.
 *
 * Returns null rather than guessing when there is none or more than one: a
 * multi-business install that has host routing switched off cannot answer
 * "which business is this request for?" at all, and picking the oldest would be
 * answering it wrongly and silently.
 *
 * Same bypass rationale as `resolveBusinessByLabel` directly above — this *is*
 * the "which business is this request for?" lookup, just for the deployment
 * shape where the answer is not in the hostname.
 */
export async function resolveSoleBusiness(): Promise<ResolvedBusinessHost | null> {
  return withoutTenantScope("host-resolution", async () => {
    const { rows } = await query<{
      id: string;
      name: string;
      subdomain: string | null;
      status: ResolvedBusinessHost["status"];
    }>(
      `SELECT id, name, subdomain::text AS subdomain, status::text AS status
         FROM businesses
        WHERE status <> 'archived'
        LIMIT 2`,
    );
    if (rows.length !== 1) return null;
    const row = rows[0];
    return {
      businessId: row.id,
      name: row.name,
      subdomain: row.subdomain ?? "",
      status: row.status,
      viaAlias: false,
    };
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

/**
 * The full set of host labels that legitimately name one business: its current
 * subdomain plus every alias left over from a rename. Used by the print
 * connector installer to build the connector's allowed-origin set — a browser
 * may still reach the POS through an alias during a rename cutover, and the
 * connector's CORS policy must match what the deployment itself serves rather
 * than what an installer request claims.
 *
 * Tenant-scoped by the caller, like every authenticated settings read.
 */
export async function listBusinessHostLabels(
  businessId: string,
): Promise<{ subdomain: string; aliases: string[] } | null> {
  const { rows } = await query<{ subdomain: string | null; aliases: unknown }>(
    `SELECT b.subdomain::text AS subdomain,
            COALESCE(
              (SELECT jsonb_agg(a.alias ORDER BY a.created_at) FROM business_subdomain_aliases a WHERE a.business_id = b.id),
              '[]'::jsonb
            ) AS aliases
       FROM businesses b
      WHERE b.id = $1`,
    [businessId],
  );
  const row = rows[0];
  if (!row) return null;
  const aliases = Array.isArray(row.aliases) ? row.aliases.map(String).filter(Boolean) : [];
  return { subdomain: row.subdomain ?? "", aliases };
}
