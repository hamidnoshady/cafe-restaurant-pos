import { NextRequest, NextResponse } from "next/server";
import { requireRole, type SessionPayload, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

async function ownedItem(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM menu_items WHERE id = $1 AND location_id = $2",
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
    categoryId?: string;
    name?: string;
    price?: number;
    description?: string | null;
    sku?: string | null;
    imageUrl?: string | null;
    sortOrder?: number;
    isActive?: boolean;
    targetMarginPercent?: number | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.categoryId !== undefined) {
    const { rows: cat } = await query(
      "SELECT id FROM menu_categories WHERE id = $1 AND location_id = $2",
      [body.categoryId, location.id],
    );
    if (cat.length === 0) return NextResponse.json({ error: "category_not_found" }, { status: 404 });
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = $${++i}`);
    values.push(val);
  };

  if (body.categoryId !== undefined) set("category_id", body.categoryId);
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    set("name", name);
  }
  if (body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isSafeInteger(price) || price < 0) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }
    set("price", price);
  }
  if (body.description !== undefined) set("description", body.description?.trim() || null);
  if (body.sku !== undefined) set("sku", body.sku?.trim() || null);
  if (body.imageUrl !== undefined) set("image_url", body.imageUrl?.trim() || null);
  if (body.sortOrder !== undefined) set("sort_order", Number(body.sortOrder) || 0);
  if (body.isActive !== undefined) set("is_active", Boolean(body.isActive));
  if (body.targetMarginPercent !== undefined) {
    if (body.targetMarginPercent === null) {
      set("target_margin_percent", null);
    } else {
      const margin = Number(body.targetMarginPercent);
      if (!Number.isFinite(margin) || margin < 0 || margin >= 100) {
        return NextResponse.json({ error: "invalid_margin" }, { status: 400 });
      }
      set("target_margin_percent", margin);
    }
  }
  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  set("updated_at", new Date());
  await query(`UPDATE menu_items SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  return NextResponse.json({ ok: true });
});

/** Items referenced by an order are deactivated, not deleted, to keep order history intact. */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await ownedItem(session, id);
  if (!location) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const { rows: refs } = await query("SELECT id FROM order_items WHERE menu_item_id = $1 LIMIT 1", [id]);
  if (refs.length > 0) {
    await query("UPDATE menu_items SET is_active = false WHERE id = $1", [id]);
    return NextResponse.json({ ok: true, deactivated: true });
  }
  await query("DELETE FROM menu_items WHERE id = $1", [id]);
  return NextResponse.json({ ok: true, deactivated: false });
});
