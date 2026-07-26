import { NextRequest, NextResponse } from "next/server";
import { requireRole, type SessionPayload, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

async function ownedModifier(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM modifiers WHERE id = $1 AND location_id = $2",
    [id, location.id],
  );
  return rows[0] ? location : null;
}

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await ownedModifier(session, id);
  if (!location) return NextResponse.json({ error: "modifier_not_found" }, { status: 404 });

  let body: { name?: string; priceDelta?: number; sortOrder?: number; isActive?: boolean };
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
  if (body.priceDelta !== undefined) {
    const delta = Number(body.priceDelta);
    if (!Number.isSafeInteger(delta)) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    set("price_delta", delta);
  }
  if (body.sortOrder !== undefined) set("sort_order", Number(body.sortOrder) || 0);
  if (body.isActive !== undefined) set("is_active", Boolean(body.isActive));
  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  await query(`UPDATE modifiers SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await ownedModifier(session, id);
  if (!location) return NextResponse.json({ error: "modifier_not_found" }, { status: 404 });

  const { rows: refs } = await query("SELECT id FROM order_item_modifiers WHERE modifier_id = $1 LIMIT 1", [
    id,
  ]);
  if (refs.length > 0) {
    await query("UPDATE modifiers SET is_active = false WHERE id = $1", [id]);
    return NextResponse.json({ ok: true, deactivated: true });
  }
  await query("DELETE FROM modifiers WHERE id = $1", [id]);
  return NextResponse.json({ ok: true, deactivated: false });
});
