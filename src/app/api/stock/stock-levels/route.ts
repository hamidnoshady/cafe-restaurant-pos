import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { classifyStockLevel } from "@/lib/retail-stock";
import { isUuid } from "@/lib/uuid";

/**
 * Phase 42b — «موجودی انبار»: the per-warehouse stock level on the RETAIL
 * model. One row per active sellable item of the warehouse: quantity and
 * running cost from `item_stock` (for a batch-tracked item that is the 0078
 * rollup of its batches), value = quantity × unit cost, and a low/out level
 * from the item's reorder point (classifyStockLevel, the same rule the
 * low-stock report uses). `?locationId` targets a warehouse (the session's
 * active location by default, like the rest of the stock module); `search`
 * filters by name or SKU; the totals feed the screen's footer.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const defaultLocation = await resolveActiveLocation(session);
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId") || defaultLocation?.id || "";
  if (!locationId) {
    return NextResponse.json({
      locationId,
      items: [],
      totals: { count: 0, lowStockCount: 0, totalUnits: "0", totalValueRial: "0" },
    });
  }
  // Validate and scope an explicitly selected warehouse before it reaches a
  // UUID comparison. This turns a bad URL into a useful 400 and prevents a
  // caller from using the stock endpoint as a cross-tenant probe.
  if (!isUuid(locationId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const search = (url.searchParams.get("search") ?? "").trim();

  const clauses = [
    "i.location_id = $1",
    "i.is_active",
    "i.kind <> 'variant_parent'",
    "EXISTS (SELECT 1 FROM locations l WHERE l.id = i.location_id AND l.business_id = $2)",
  ];
  const params: unknown[] = [locationId, session.businessId];
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(i.name ILIKE $${params.length} OR i.sku ILIKE $${params.length})`);
  }

  const { rows } = await query<{
    id: string;
    name: string;
    sku: string | null;
    tracking: string;
    quantity: string;
    unit_cost: string | null;
    reorder_point: string;
  }>(
    `SELECT i.id, i.name, i.sku, i.tracking::text,
            COALESCE(s.quantity, 0)::text AS quantity,
            s.unit_cost::text, COALESCE(s.reorder_point, 0)::text AS reorder_point
       FROM items i
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE ${clauses.join(" AND ")}
      ORDER BY i.name`,
    params,
  );

  const items = rows.map((r) => ({
    id: r.id,
    name: r.name,
    sku: r.sku,
    tracking: r.tracking,
    quantity: r.quantity,
    unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
    reorderPoint: r.reorder_point,
    valueRial: Math.round(Number(r.quantity) * Number(r.unit_cost ?? 0)),
    level: classifyStockLevel(r.quantity, r.reorder_point),
  }));

  let totalUnits = 0;
  let totalValue = 0;
  let lowStockCount = 0;
  for (const item of items) {
    totalUnits += Number(item.quantity);
    totalValue += item.valueRial;
    if (item.level === "low" || item.level === "out") lowStockCount += 1;
  }

  return NextResponse.json({
    locationId,
    items,
    totals: {
      count: items.length,
      lowStockCount,
      totalUnits: String(Math.round(totalUnits * 1_000_000) / 1_000_000),
      totalValueRial: String(totalValue),
    },
  });
});
