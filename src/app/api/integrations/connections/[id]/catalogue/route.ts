import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getConnection } from "@/lib/integrations/connections-service";
import { catalogueFor } from "@/lib/integrations/sync-service";
import { classifyWooProductType } from "@/lib/integrations/woo-catalogue";

/**
 * The synced catalogue, as the dashboard shows it: every mapped product with
 * its WooCommerce type, its retail item kind (or nothing, for an F&B menu
 * item), its categories, its variation attributes, and its local stock and
 * price.
 *
 * One shape for both industries on purpose. F&B writes `menu_items` and
 * retail writes `items` + `item_stock`, and a screen that had to know which
 * would be two screens.
 */
export const GET = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const connection = await getConnection(session.businessId, id);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { industry, rows } = await catalogueFor(session.businessId, id);

  const summary = {
    total: rows.length,
    sellable: rows.filter((r) => r.sellable).length,
    containers: rows.filter((r) => !r.sellable).length,
    variations: rows.filter((r) => classifyWooProductType(r.wooType) === "variation").length,
    outOfStock: rows.filter((r) => r.quantity === 0).length,
    uncategorised: rows.filter((r) => r.categories.length === 0).length,
  };

  return NextResponse.json({
    industry,
    summary,
    products: rows.map((row) => ({
      ...row,
      priceRial: row.priceRial === null ? null : row.priceRial.toString(),
    })),
  });
});
