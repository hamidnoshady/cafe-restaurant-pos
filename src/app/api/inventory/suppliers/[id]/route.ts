import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { getPrimaryLocation } from "@/lib/setup-state";

async function ownedSupplier(businessId: string, id: string) {
  const location = await getPrimaryLocation(businessId);
  if (!location) return null;
  const { rows } = await query<{ id: string }>("SELECT id FROM suppliers WHERE id = $1 AND location_id = $2", [
    id,
    location.id,
  ]);
  return rows[0] ? location : null;
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await ownedSupplier(session.businessId, id);
  if (!location) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { name?: string; phone?: string | null; notes?: string | null; isActive?: boolean };
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
  if (body.phone !== undefined) set("phone", body.phone?.trim() || null);
  if (body.notes !== undefined) set("notes", body.notes?.trim() || null);
  if (body.isActive !== undefined) set("is_active", Boolean(body.isActive));
  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  await query(`UPDATE suppliers SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await ownedSupplier(session.businessId, id);
  if (!location) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { rows: refs } = await query("SELECT 1 FROM purchases WHERE supplier_id = $1 LIMIT 1", [id]);
  if (refs.length > 0) {
    await query("UPDATE suppliers SET is_active = false WHERE id = $1", [id]);
    return NextResponse.json({ ok: true, deactivated: true });
  }
  await query("DELETE FROM suppliers WHERE id = $1", [id]);
  return NextResponse.json({ ok: true, deactivated: false });
}
