import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { getPrimaryLocation } from "@/lib/setup-state";

async function ownedCategory(businessId: string, id: string) {
  const location = await getPrimaryLocation(businessId);
  if (!location) return null;
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM menu_categories WHERE id = $1 AND location_id = $2",
    [id, location.id],
  );
  return rows[0] ? location : null;
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await ownedCategory(session.businessId, id);
  if (!location) return NextResponse.json({ error: "category_not_found" }, { status: 404 });

  let body: { name?: string; taxRate?: number; sortOrder?: number; isActive?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    fields.push(`name = $${++i}`);
    values.push(name);
  }
  if (body.taxRate !== undefined) {
    const rate = Number(body.taxRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return NextResponse.json({ error: "invalid_rate" }, { status: 400 });
    }
    fields.push(`tax_rate = $${++i}`);
    values.push(rate);
  }
  if (body.sortOrder !== undefined) {
    fields.push(`sort_order = $${++i}`);
    values.push(Number(body.sortOrder) || 0);
  }
  if (body.isActive !== undefined) {
    fields.push(`is_active = $${++i}`);
    values.push(Boolean(body.isActive));
  }
  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  await query(`UPDATE menu_categories SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  return NextResponse.json({ ok: true });
}

/** Categories with items are deactivated, not deleted, so historical orders keep their references. */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await ownedCategory(session.businessId, id);
  if (!location) return NextResponse.json({ error: "category_not_found" }, { status: 404 });

  const { rows: items } = await query("SELECT id FROM menu_items WHERE category_id = $1 LIMIT 1", [id]);
  if (items.length > 0) {
    await query("UPDATE menu_categories SET is_active = false WHERE id = $1", [id]);
    return NextResponse.json({ ok: true, deactivated: true });
  }
  await query("DELETE FROM menu_categories WHERE id = $1", [id]);
  return NextResponse.json({ ok: true, deactivated: false });
}
