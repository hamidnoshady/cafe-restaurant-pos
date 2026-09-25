import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { deleteModifier, updateModifier } from "@/lib/menu-service";
import { validateModifierPatch } from "@/lib/menu-validation";
import { resolveActiveLocation } from "@/lib/setup-state";

async function ownedModifier(locationId: string, id: string) {
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM modifiers WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  return rows[0] != null;
}

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownedModifier(location.id, id)))
    return NextResponse.json({ error: "modifier_not_found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const input = validateModifierPatch(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const result = await updateModifier(location.id, id, input.value);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
});

/** Modifiers referenced by an order are deactivated, not deleted; a still-needed option refuses to go. */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownedModifier(location.id, id)))
    return NextResponse.json({ error: "modifier_not_found" }, { status: 404 });

  const result = await deleteModifier(location.id, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, deactivated: result.deactivated ?? false });
});
