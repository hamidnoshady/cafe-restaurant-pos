import { NextRequest, NextResponse } from "next/server";
import { requireRole, type SessionPayload, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { type ModifierPatchInput, updateModifier } from "@/lib/menu-service";
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

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "modifier_not_found" }, { status: 404 });

  let body: ModifierPatchInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await updateModifier(location.id, id, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
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
