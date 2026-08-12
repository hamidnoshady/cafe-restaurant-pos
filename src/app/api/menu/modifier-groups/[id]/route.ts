import { NextRequest, NextResponse } from "next/server";
import { requireRole, type SessionPayload, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveSelectionBounds, type SelectionBounds } from "@/lib/modifier-selection";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * The group's own stored bounds come back with it: a PATCH may send only one
 * side, and the min <= max check then has to be made against what's in the
 * database rather than against a default.
 */
async function ownedGroup(session: SessionPayload, id: string): Promise<SelectionBounds | null> {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const { rows } = await query<{ min_select: number; max_select: number }>(
    "SELECT min_select, max_select FROM modifier_groups WHERE id = $1 AND location_id = $2",
    [id, location.id],
  );
  const group = rows[0];
  return group ? { min: group.min_select, max: group.max_select } : null;
}

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const current = await ownedGroup(session, id);
  if (!current) return NextResponse.json({ error: "group_not_found" }, { status: 404 });

  let body: { name?: string; minSelect?: unknown; maxSelect?: unknown };
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
  if (body.minSelect !== undefined || body.maxSelect !== undefined) {
    const bounds = resolveSelectionBounds(current, body);
    if (!bounds) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    if (body.minSelect !== undefined) set("min_select", bounds.min);
    if (body.maxSelect !== undefined) set("max_select", bounds.max);
  }
  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  await query(`UPDATE modifier_groups SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  if (!(await ownedGroup(session, id))) {
    return NextResponse.json({ error: "group_not_found" }, { status: 404 });
  }

  // ON DELETE CASCADE on modifier_groups → modifiers; order_item_modifiers keep a name/price
  // snapshot and only SET NULL their modifier_id, so past orders are unaffected.
  await query("DELETE FROM modifier_groups WHERE id = $1", [id]);
  return NextResponse.json({ ok: true });
});
