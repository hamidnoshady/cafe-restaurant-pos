import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Upsert one modifier recipe line: the signed change in an inventory item's
 * consumption when this modifier is selected (negative = removes/swaps out,
 * positive = adds), on top of the menu item's own recipe.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { modifierId?: string; inventoryItemId?: string; quantityDelta?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { modifierId, inventoryItemId } = body;
  const quantityDelta = Number(body.quantityDelta);
  if (!modifierId || !inventoryItemId || !Number.isFinite(quantityDelta) || quantityDelta === 0) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: owned } = await query(
    `SELECT 1 FROM modifiers WHERE id = $1 AND location_id = $2
       AND EXISTS (SELECT 1 FROM inventory_items WHERE id = $3 AND location_id = $2)`,
    [modifierId, location.id, inventoryItemId],
  );
  if (owned.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await query(
    `INSERT INTO modifier_ingredients (modifier_id, inventory_item_id, quantity_delta) VALUES ($1, $2, $3)
     ON CONFLICT (modifier_id, inventory_item_id) DO UPDATE SET quantity_delta = EXCLUDED.quantity_delta`,
    [modifierId, inventoryItemId, quantityDelta],
  );
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const modifierId = searchParams.get("modifierId");
  const inventoryItemId = searchParams.get("inventoryItemId");
  if (!modifierId || !inventoryItemId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  await query(
    `DELETE FROM modifier_ingredients WHERE modifier_id = $1 AND inventory_item_id = $2
       AND modifier_id IN (SELECT id FROM modifiers WHERE location_id = $3)`,
    [modifierId, inventoryItemId, location.id],
  );
  return NextResponse.json({ ok: true });
});
