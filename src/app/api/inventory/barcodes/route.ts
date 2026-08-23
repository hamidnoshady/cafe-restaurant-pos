import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  assignBarcode,
  listBarcodes,
  listItemsWithoutBarcode,
} from "@/lib/inventory-item-barcodes-service";

/**
 * Barcode assignment for F&B raw ingredients.
 *
 * Unlike the retail /api/barcodes counterpart there is no `barcode` capability
 * check: that capability switches the feature on for the four retail trades,
 * and `inventory_items` belongs to food_service alone. The module guard in
 * withTenantScope already refuses /api/inventory/* for a trade without the
 * inventory module, which is the same boundary one level up.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: {
    inventoryItemId?: string;
    code?: string | null;
    symbology?: string | null;
    note?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const inventoryItemId = typeof body.inventoryItemId === "string" ? body.inventoryItemId : "";
  if (!inventoryItemId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  // The caller's active branch, not merely the tenant, decides ownership —
  // RLS scopes to the business, and a business may have several branches.
  const { rows: owned } = await query<{ id: string }>(
    "SELECT id FROM inventory_items WHERE id = $1 AND location_id = $2",
    [inventoryItemId, location.id],
  );
  if (!owned[0]) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  try {
    const barcode = await assignBarcode(inventoryItemId, {
      code: typeof body.code === "string" ? body.code : null,
      symbology: typeof body.symbology === "string" ? (body.symbology as "EAN13" | "UPC" | "internal") : null,
      note: typeof body.note === "string" ? body.note : null,
    });
    return NextResponse.json({ ok: true, barcode });
  } catch (err) {
    return NextResponse.json({ error: "barcode_failed", message: (err as Error).message }, { status: 400 });
  }
});

/**
 * Either every code stuck to one ingredient (`?inventoryItemId=`), or — with
 * no item named — the ingredients at this branch that still have none, which
 * is what the bulk label run works from.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const inventoryItemId = request.nextUrl.searchParams.get("inventoryItemId") ?? "";
  if (!inventoryItemId) {
    return NextResponse.json({ pending: await listItemsWithoutBarcode(location.id) });
  }

  const { rows: owned } = await query<{ id: string }>(
    "SELECT id FROM inventory_items WHERE id = $1 AND location_id = $2",
    [inventoryItemId, location.id],
  );
  if (!owned[0]) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  return NextResponse.json({ barcodes: await listBarcodes(inventoryItemId) });
});
