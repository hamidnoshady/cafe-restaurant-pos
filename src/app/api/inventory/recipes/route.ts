import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

/** Upsert one recipe line: how much of an inventory item one unit of a menu item consumes. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { menuItemId?: string; inventoryItemId?: string; quantity?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { menuItemId, inventoryItemId } = body;
  const quantity = Number(body.quantity);
  if (!menuItemId || !inventoryItemId || !Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: owned } = await query(
    `SELECT 1 FROM menu_items WHERE id = $1 AND location_id = $2
       AND EXISTS (SELECT 1 FROM inventory_items WHERE id = $3 AND location_id = $2)`,
    [menuItemId, location.id, inventoryItemId],
  );
  if (owned.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await query(
    `INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity) VALUES ($1, $2, $3)
     ON CONFLICT (menu_item_id, inventory_item_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
    [menuItemId, inventoryItemId, quantity],
  );
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const menuItemId = searchParams.get("menuItemId");
  const inventoryItemId = searchParams.get("inventoryItemId");
  if (!menuItemId || !inventoryItemId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  await query(
    `DELETE FROM menu_item_ingredients WHERE menu_item_id = $1 AND inventory_item_id = $2
       AND menu_item_id IN (SELECT id FROM menu_items WHERE location_id = $3)`,
    [menuItemId, inventoryItemId, location.id],
  );
  return NextResponse.json({ ok: true });
});
