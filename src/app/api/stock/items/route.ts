import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

/** Sellable items (variants, not families) with stock, for the purchase/transfer pickers. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const active = await resolveActiveLocation(session);
  const requestedLocation = request.nextUrl.searchParams.get("locationId");
  const locationId = requestedLocation || active?.id;
  if (!locationId) return NextResponse.json({ items: [] });

  const { rows } = await query<{
    id: string;
    name: string;
    sku: string | null;
    tracking: string;
    quantity: string;
    unit_cost: string | null;
    unit_price: string | null;
  }>(
    `SELECT i.id, i.name, i.sku, i.tracking,
            COALESCE(s.quantity, 0)::text AS quantity,
            s.unit_cost::text, s.unit_price::text
       FROM items i
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.location_id = $1 AND i.kind <> 'variant_parent' AND i.is_active
      ORDER BY i.name`,
    [locationId],
  );

  return NextResponse.json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      sku: r.sku,
      tracking: r.tracking,
      quantity: r.quantity,
      unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
      unitPrice: r.unit_price == null ? null : Number(r.unit_price),
    })),
  });
});
