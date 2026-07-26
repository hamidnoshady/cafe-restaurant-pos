import { NextRequest, NextResponse } from "next/server";
import { requireRole, type SessionPayload } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

async function ownedGroup(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM modifier_groups WHERE id = $1 AND location_id = $2",
    [id, location.id],
  );
  return rows[0] ? location : null;
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await ownedGroup(session, id);
  if (!location) return NextResponse.json({ error: "group_not_found" }, { status: 404 });

  let body: { name?: string; minSelect?: number; maxSelect?: number };
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
  if (body.minSelect !== undefined) set("min_select", Number(body.minSelect) || 0);
  if (body.maxSelect !== undefined) set("max_select", Number(body.maxSelect) || 1);
  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  await query(`UPDATE modifier_groups SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await ownedGroup(session, id);
  if (!location) return NextResponse.json({ error: "group_not_found" }, { status: 404 });

  // ON DELETE CASCADE on modifier_groups → modifiers; order_item_modifiers keep a name/price
  // snapshot and only SET NULL their modifier_id, so past orders are unaffected.
  await query("DELETE FROM modifier_groups WHERE id = $1", [id]);
  return NextResponse.json({ ok: true });
}
