import { NextRequest, NextResponse } from "next/server";
import { requireRole, type SessionPayload, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

async function ownedItem(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM inventory_items WHERE id = $1 AND location_id = $2",
    [id, location.id],
  );
  return rows[0] ? location : null;
}

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await ownedItem(session, id);
  if (!location) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  let body: {
    name?: string;
    unit?: string;
    sku?: string | null;
    reorderLevel?: number | null;
    purchaseUnit?: string | null;
    purchaseUnitFactor?: number;
    isActive?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = $${++i}`);
    values.push(val);
  };

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    set("name", name);
  }
  if (body.unit !== undefined) {
    const unit = body.unit.trim();
    if (!unit) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    set("unit", unit);
  }
  if (body.sku !== undefined) set("sku", body.sku?.trim() || null);
  if (body.reorderLevel !== undefined) {
    const reorderLevel = body.reorderLevel === null ? null : Number(body.reorderLevel);
    if (reorderLevel !== null && (!Number.isFinite(reorderLevel) || reorderLevel < 0)) {
      return NextResponse.json({ error: "invalid_reorder_level" }, { status: 400 });
    }
    set("reorder_level", reorderLevel);
  }
  if (body.purchaseUnit !== undefined) set("purchase_unit", body.purchaseUnit?.trim() || null);
  if (body.purchaseUnitFactor !== undefined) {
    const factor = Number(body.purchaseUnitFactor);
    if (!Number.isFinite(factor) || factor <= 0) {
      return NextResponse.json({ error: "invalid_purchase_unit_factor" }, { status: 400 });
    }
    set("purchase_unit_factor", factor);
  }
  if (body.isActive !== undefined) set("is_active", Boolean(body.isActive));
  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  await query(`UPDATE inventory_items SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  return NextResponse.json({ ok: true });
});

/** Items referenced by a recipe, purchase, or stock movement are deactivated, not deleted. */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await ownedItem(session, id);
  if (!location) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const { rows: refs } = await query(
    `SELECT 1 FROM menu_item_ingredients WHERE inventory_item_id = $1
     UNION ALL SELECT 1 FROM modifier_ingredients WHERE inventory_item_id = $1
     UNION ALL SELECT 1 FROM stock_movements WHERE inventory_item_id = $1
     LIMIT 1`,
    [id],
  );
  if (refs.length > 0) {
    await query("UPDATE inventory_items SET is_active = false WHERE id = $1", [id]);
    return NextResponse.json({ ok: true, deactivated: true });
  }
  await query("DELETE FROM inventory_items WHERE id = $1", [id]);
  return NextResponse.json({ ok: true, deactivated: false });
});
