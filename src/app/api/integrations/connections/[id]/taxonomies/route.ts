import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getConnection } from "@/lib/integrations/connections-service";
import { listTerms } from "@/lib/integrations/woo-taxonomy-service";
import { isWooAttributeTaxonomy, sortWooTerms, wooTaxonomyLabel } from "@/lib/integrations/woo-catalogue";

/**
 * The store's taxonomy tree: categories, tags, attribute terms, and whatever
 * custom taxonomies its plugins registered.
 *
 * Attribute taxonomies (`pa_*`) come first in the ordering because they are
 * the ones that make one variation distinguishable from another — the answer
 * to "why are there twelve rows called تی‌شرت". Custom taxonomies are last
 * and labelled by slug, since a name this app has no translation for is
 * better shown than invented.
 */
export const GET = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const connection = await getConnection(session.businessId, id);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const taxonomy = new URL(request.url).searchParams.get("taxonomy");
  const terms = await listTerms(session.businessId, id, taxonomy ?? undefined);

  const byTaxonomy = new Map<string, typeof terms>();
  for (const term of terms) {
    const list = byTaxonomy.get(term.taxonomy) ?? [];
    list.push(term);
    byTaxonomy.set(term.taxonomy, list);
  }

  const groups = [...byTaxonomy.entries()]
    .map(([slug, group]) => ({
      taxonomy: slug,
      label: wooTaxonomyLabel(slug),
      isAttribute: isWooAttributeTaxonomy(slug),
      termCount: group.length,
      // Tree order: parents before children, siblings by menu_order.
      terms: sortWooTerms(group).map((t) => ({
        remoteId: t.remoteId,
        parentRemoteId: t.parentRemoteId,
        name: t.name,
        slug: t.slug,
        remoteCount: t.remoteCount,
        mappedCount: t.mappedCount,
      })),
    }))
    .sort((a, b) => {
      if (a.isAttribute !== b.isAttribute) return a.isAttribute ? -1 : 1;
      const rank = (slug: string) => (slug === "product_cat" ? 0 : slug === "product_tag" ? 1 : 2);
      return rank(a.taxonomy) - rank(b.taxonomy) || a.label.localeCompare(b.label, "fa");
    });

  return NextResponse.json({
    groups,
    total: terms.length,
    // A store with no synced tree: the catalogue sync writes it, so say so
    // rather than showing an empty box with no explanation.
    syncedAt: connection.last_catalogue_sync_at,
  });
});
