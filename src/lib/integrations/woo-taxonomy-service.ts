/**
 * Phase 38 — the store's taxonomy tree, mirrored.
 *
 * Categories, tags, attribute terms and whatever custom taxonomies a store's
 * theme or plugins registered, as rows keyed by *remote* id.
 *
 * Why a mirror and not a local category model: F&B has `menu_categories` and
 * retail has none at all, so "the category an item belongs to" is not a
 * question this product has one answer to. Inventing one for `items` to hold
 * a WooCommerce import would change what the retail modules show for every
 * business, connected or not — and it would silently lose the shape of a
 * taxonomy that is *not* a category (an attribute's terms are what
 * distinguishes one variation from another; a brand is metadata, not a
 * folder). So this table holds what the store says, and the only local write
 * is the explicit, opt-in `sync_categories` bridge into `menu_categories`.
 */
import { query } from "../db";
import { localIdForRemote, upsertMapping } from "./mapping-service";
import type { WooTerm } from "./woocommerce-client";

export type WooTermSnapshot = WooTerm & { taxonomy?: string; menu_order?: number };

/** How many terms of one taxonomy a single sync will store. */
const TERMS_PER_TAXONOMY_LIMIT = 5000;

export interface StoredTerm {
  taxonomy: string;
  remoteId: string;
  parentRemoteId: string | null;
  name: string;
  slug: string;
  description: string;
  remoteCount: number;
  menuOrder: number;
}

export interface TaxonomySyncOutcome {
  taxonomies: string[];
  terms: number;
  truncated: boolean;
}

/** One taxonomy's terms, in the shape the table stores. */
function toStored(taxonomy: string, terms: WooTerm[]): StoredTerm[] {
  return terms.slice(0, TERMS_PER_TAXONOMY_LIMIT).map((term) => ({
    taxonomy,
    remoteId: String(term.id),
    parentRemoteId: term.parent ? String(term.parent) : null,
    name: term.name ?? "",
    slug: term.slug ?? "",
    description: term.description ?? "",
    remoteCount: Number(term.count ?? 0),
    menuOrder: Number(term.menu_order ?? 0),
  }));
}

/**
 * Replace one taxonomy's terms for a connection.
 *
 * "Replace" rather than "merge", because a term deleted in the store must
 * stop appearing here — a merge leaves ghosts that an owner cannot remove
 * from either system. The delete is scoped to the one taxonomy, so a failed
 * read for a later taxonomy cannot empty an earlier one.
 */
export async function replaceTerms(
  businessId: string,
  connectionId: string,
  taxonomy: string,
  terms: WooTerm[],
): Promise<number> {
  if (!taxonomy) return 0;
  const stored = toStored(taxonomy, terms);
  await query(`DELETE FROM integration_woo_terms WHERE connection_id = $1 AND taxonomy = $2`, [
    connectionId,
    taxonomy,
  ]);
  for (const term of stored) {
    await query(
      `INSERT INTO integration_woo_terms
         (business_id, connection_id, taxonomy, remote_id, parent_remote_id,
          name, slug, description, remote_count, menu_order, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        businessId,
        connectionId,
        term.taxonomy,
        term.remoteId,
        term.parentRemoteId,
        term.name,
        term.slug,
        term.description,
        term.remoteCount,
        term.menuOrder,
        JSON.stringify(term),
      ],
    );
  }
  return stored.length;
}

/**
 * Sync the whole tree: core taxonomies, every global attribute's terms, and
 * every custom taxonomy the store publishes for products.
 *
 * One taxonomy failing does not abort the rest — a shop with a broken custom
 * taxonomy still gets its categories. That is also why the per-taxonomy
 * writes are not wrapped in a single transaction: a rollback would take the
 * good ones with it.
 */
export async function syncTaxonomyTree(
  businessId: string,
  connectionId: string,
  client: {
    listCategories(q?: Record<string, string | number | boolean>): Promise<WooTerm[]>;
    listTags(q?: Record<string, string | number | boolean>): Promise<WooTerm[]>;
    listAttributes(): Promise<{ id: number; slug: string; taxonomy?: string }[]>;
    listAttributeTerms(id: number): Promise<WooTerm[]>;
    listTaxonomies(): Promise<{ slug: string; rest_base?: string; types?: string[] }[]>;
    listTerms(taxonomy: string, q?: Record<string, string | number | boolean>): Promise<WooTerm[]>;
  },
): Promise<TaxonomySyncOutcome> {
  const taxonomies: string[] = [];
  let total = 0;
  let truncated = false;

  const store = async (taxonomy: string, terms: WooTerm[]) => {
    if (terms.length > TERMS_PER_TAXONOMY_LIMIT) truncated = true;
    const count = await replaceTerms(businessId, connectionId, taxonomy, terms);
    total += count;
    taxonomies.push(taxonomy);
  };

  const attempt = async (label: string, read: () => Promise<WooTerm[]>, taxonomy: string) => {
    try {
      await store(taxonomy, await read());
    } catch {
      // Recorded by the caller's audit; the tree is best-effort by design.
      void label;
    }
  };

  await attempt("categories", () => client.listCategories(), "product_cat");
  await attempt("tags", () => client.listTags(), "product_tag");

  // Attribute terms — `pa_colour` and friends. These are what make one
  // variation distinguishable from another, so they are the most useful
  // taxonomy in the whole tree for a store that sells variations.
  try {
    const attributes = await client.listAttributes();
    for (const attribute of attributes) {
      const taxonomy = attribute.taxonomy || (attribute.slug.startsWith("pa_") ? attribute.slug : `pa_${attribute.slug}`);
      try {
        await store(taxonomy, await client.listAttributeTerms(attribute.id));
      } catch {
        // One unreadable attribute must not stop the rest of the tree.
      }
    }
  } catch {
    // No attributes, or the endpoint is unavailable. Not fatal.
  }

  // Custom taxonomies: a brand, a fabric, a region — anything a plugin
  // registered. wc/v3 never mentions them, which is why this goes to wp/v2.
  try {
    const discovered = await client.listTaxonomies();
    const known = new Set(["product_cat", "product_tag"]);
    for (const taxonomy of discovered) {
      const slug = taxonomy.rest_base || taxonomy.slug;
      if (!slug || known.has(slug)) continue;
      if (slug.startsWith("pa_")) continue; // already read as an attribute
      if (!(taxonomy.types ?? []).includes("product")) continue;
      known.add(slug);
      try {
        await store(slug, await client.listTerms(slug));
      } catch {
        // A taxonomy that cannot be read is skipped, not fatal.
      }
    }
  } catch {
    // wp/v2 may be blocked on a hardened store. Categories still landed.
  }

  return { taxonomies, terms: total, truncated };
}

/**
 * Record one term the store told us about *inline* with a product payload.
 *
 * The REST sync reads the whole tree from `products/categories` and the
 * attribute/tag endpoints, but in plugin mode the app never dials the store:
 * the only taxonomy facts that ever arrive are the `categories`/`tags`
 * arrays carried on each pushed product. Without this, a plugin-connected
 * store's taxonomy browser stayed empty forever and the «دسته‌بندی‌ها» column
 * on the catalogue was blank even though every product named its categories.
 *
 * Upsert (never delete) is the right semantics here: a term omitted from one
 * product's payload is not a term that stopped existing, and the full tree
 * replace stays the job of `replaceTerms`. The remote product count is left
 * as-is on conflict because a product payload only proves membership, not the
 * store's authoritative count.
 */
export async function upsertTermFromPayload(
  businessId: string,
  connectionId: string,
  taxonomy: string,
  term: { id: number | string; name?: string; slug?: string; parent?: number; description?: string; count?: number; menu_order?: number },
): Promise<void> {
  const remoteId = String(term.id ?? "");
  if (!taxonomy || !remoteId || remoteId === "0") return;
  const name = (term.name ?? "").trim();
  const slug = (term.slug ?? "").trim();
  if (!name && !slug) return;
  await query(
    `INSERT INTO integration_woo_terms
       (business_id, connection_id, taxonomy, remote_id, parent_remote_id, name, slug, description, remote_count, menu_order, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (connection_id, taxonomy, remote_id)
     DO UPDATE SET parent_remote_id = COALESCE($5, integration_woo_terms.parent_remote_id),
                   name = CASE WHEN $6 <> '' THEN $6 ELSE integration_woo_terms.name END,
                   slug = CASE WHEN $7 <> '' THEN $7 ELSE integration_woo_terms.slug END,
                   description = CASE WHEN $8 <> '' THEN $8 ELSE integration_woo_terms.description END,
                   remote_count = GREATEST(integration_woo_terms.remote_count, $9),
                   menu_order = CASE WHEN $10 <> 0 THEN $10 ELSE integration_woo_terms.menu_order END,
                   updated_at = now()`,
    [
      businessId,
      connectionId,
      taxonomy,
      remoteId,
      term.parent ? String(term.parent) : null,
      name,
      slug,
      (term.description ?? "").trim(),
      Math.max(0, Number(term.count ?? 0)),
      Number(term.menu_order ?? 0),
      JSON.stringify(term),
    ],
  );
}

/**
 * Mirror every category and tag a pushed product carries, then record the
 * product→term assignments. Called by the single product ingest path so REST
 * pulls, webhooks and plugin pushes all keep the taxonomy mirror populated.
 */
export async function recordProductTermsFromPayload(
  businessId: string,
  connectionId: string,
  remoteProductId: string,
  product: {
    categories?: { id: number; name?: string; slug?: string }[];
    tags?: { id: number; name?: string; slug?: string }[];
    terms?: Record<string, { id: number | string; name?: string; slug?: string; parent?: number; description?: string; count?: number; menu_order?: number }[]>;
  },
): Promise<void> {
  const assignments: { taxonomy: string; termRemoteId: string }[] = [];
  for (const category of product.categories ?? []) {
    await upsertTermFromPayload(businessId, connectionId, "product_cat", category);
    assignments.push({ taxonomy: "product_cat", termRemoteId: String(category.id) });
  }
  for (const tag of product.tags ?? []) {
    await upsertTermFromPayload(businessId, connectionId, "product_tag", tag);
    assignments.push({ taxonomy: "product_tag", termRemoteId: String(tag.id) });
  }
  for (const [taxonomy, terms] of Object.entries(product.terms ?? {})) {
    if (!taxonomy || taxonomy === "product_cat" || taxonomy === "product_tag") continue;
    for (const term of terms ?? []) {
      await upsertTermFromPayload(businessId, connectionId, taxonomy, term);
      assignments.push({ taxonomy, termRemoteId: String(term.id) });
    }
  }
  await replaceProductTerms(businessId, connectionId, remoteProductId, assignments);
}

/** Which remote terms one remote product carries. */
export async function replaceProductTerms(
  businessId: string,
  connectionId: string,
  remoteId: string,
  assignments: { taxonomy: string; termRemoteId: string }[],
): Promise<void> {
  await query(`DELETE FROM integration_woo_product_terms WHERE connection_id = $1 AND remote_id = $2`, [
    connectionId,
    remoteId,
  ]);
  for (const assignment of assignments) {
    if (!assignment?.taxonomy || !assignment?.termRemoteId) continue;
    await query(
      `INSERT INTO integration_woo_product_terms (business_id, connection_id, remote_id, taxonomy, term_remote_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (connection_id, remote_id, taxonomy, term_remote_id) DO NOTHING`,
      [businessId, connectionId, remoteId, assignment.taxonomy, assignment.termRemoteId],
    );
  }
}

export interface TermRow {
  taxonomy: string;
  remoteId: string;
  parentRemoteId: string | null;
  name: string;
  slug: string;
  description: string;
  remoteCount: number;
  menuOrder: number;
  /** How many of this connection's mapped products carry the term. */
  mappedCount: number;
}

export async function listTerms(
  businessId: string,
  connectionId: string,
  taxonomy?: string,
): Promise<TermRow[]> {
  const { rows } = await query<{
    taxonomy: string;
    remote_id: string;
    parent_remote_id: string | null;
    name: string;
    slug: string;
    description: string;
    remote_count: number;
    menu_order: number;
    mapped_count: string;
  }>(
    `SELECT t.taxonomy, t.remote_id, t.parent_remote_id, t.name, t.slug, t.description,
            t.remote_count, t.menu_order,
            (SELECT COUNT(DISTINCT pt.remote_id)
               FROM integration_woo_product_terms pt
               JOIN integration_mappings m
                 ON m.connection_id = pt.connection_id
                AND m.entity_type = 'product'
                AND m.remote_id = pt.remote_id
              WHERE pt.connection_id = t.connection_id
                AND pt.taxonomy = t.taxonomy
                AND pt.term_remote_id = t.remote_id)::text AS mapped_count
       FROM integration_woo_terms t
      WHERE t.business_id = $1 AND t.connection_id = $2
        AND ($3::text IS NULL OR t.taxonomy = $3)
      ORDER BY t.taxonomy, t.menu_order, t.name`,
    [businessId, connectionId, taxonomy ?? null],
  );
  return rows.map((r) => ({
    taxonomy: r.taxonomy,
    remoteId: r.remote_id,
    parentRemoteId: r.parent_remote_id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    remoteCount: Number(r.remote_count),
    menuOrder: Number(r.menu_order),
    mappedCount: Number(r.mapped_count),
  }));
}

/** Term names per remote product id — used to label a catalogue row. */
export async function termsByRemoteId(
  businessId: string,
  connectionId: string,
  remoteIds: string[],
  taxonomy = "product_cat",
): Promise<Map<string, { remoteId: string; name: string }[]>> {
  const out = new Map<string, { remoteId: string; name: string }[]>();
  if (remoteIds.length === 0) return out;
  const { rows } = await query<{ remote_id: string; term_remote_id: string; name: string }>(
    `SELECT pt.remote_id, pt.term_remote_id, COALESCE(t.name, '') AS name
       FROM integration_woo_product_terms pt
       LEFT JOIN integration_woo_terms t
         ON t.connection_id = pt.connection_id AND t.taxonomy = pt.taxonomy AND t.remote_id = pt.term_remote_id
      WHERE pt.business_id = $1 AND pt.connection_id = $2 AND pt.taxonomy = $3
        AND pt.remote_id = ANY($4::text[])
      ORDER BY pt.term_remote_id`,
    [businessId, connectionId, taxonomy, remoteIds],
  );
  for (const row of rows) {
    const list = out.get(row.remote_id) ?? [];
    list.push({ remoteId: row.term_remote_id, name: row.name });
    out.set(row.remote_id, list);
  }
  return out;
}

/**
 * The F&B bridge: make sure a `menu_categories` row exists for a WooCommerce
 * category, so an online menu's own navigation is not lost on the way into
 * the POS.
 *
 * Off unless the connection's `sync_categories` is set — copying a store's
 * categories into a menu an owner curated by hand is not a side effect an
 * upgrade is allowed to have.
 */
export async function ensureMenuCategory(
  businessId: string,
  connectionId: string,
  locationId: string,
  term: { remoteId: string; name: string; slug: string; menuOrder?: number },
): Promise<string | null> {
  if (!term.name.trim()) return null;
  const existing = await localIdForRemote(businessId, connectionId, "category", term.remoteId);
  if (existing) {
    await query(
      `UPDATE menu_categories SET name = $3, sort_order = $4
        WHERE id = $1 AND location_id = $2`,
      [existing, locationId, term.name.trim(), term.menuOrder ?? 0],
    );
    return existing;
  }
  // Name-keyed, not slug-keyed: `menu_categories` has no unique constraint
  // to conflict against, and a category the owner already created by that
  // name in the POS must be paired with rather than duplicated — two menu
  // categories called «پوشاک» is exactly the mess this bridge exists to
  // avoid.
  const { rows: byName } = await query<{ id: string }>(
    `SELECT id FROM menu_categories WHERE location_id = $1 AND name = $2 LIMIT 1`,
    [locationId, term.name.trim()],
  );
  const categoryId =
    byName[0]?.id ??
    (
      await query<{ id: string }>(
        `INSERT INTO menu_categories (location_id, name, sort_order)
         VALUES ($1, $2, $3) RETURNING id`,
        [locationId, term.name.trim(), term.menuOrder ?? 0],
      )
    ).rows[0]?.id;
  if (!categoryId) return null;
  await upsertMapping(businessId, connectionId, "category", term.remoteId, categoryId);
  return categoryId;
}
