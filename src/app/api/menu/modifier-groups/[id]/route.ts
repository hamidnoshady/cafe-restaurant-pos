import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { deleteModifierGroup, updateModifierGroup } from "@/lib/menu-service";
import { validateModifierGroupPatch } from "@/lib/menu-validation";
import { resolveActiveLocation } from "@/lib/setup-state";

async function ownedGroup(locationId: string, id: string) {
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM modifier_groups WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  return rows[0] != null;
}

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownedGroup(location.id, id)))
    return NextResponse.json({ error: "group_not_found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const input = validateModifierGroupPatch(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const result = await updateModifierGroup(location.id, id, input.value);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
});

/**
 * Delete a modifier group.
 *
 * When any of its options have been sold, the destructive path is refused and
 * the group is *disabled* instead — the same rule items, categories and
 * modifiers already follow. Disabling (PATCH `{ isActive: false }`) is the
 * reversible way to take a group off the menu; this stays the explicit
 * destructive action for configuration nothing references.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownedGroup(location.id, id)))
    return NextResponse.json({ error: "group_not_found" }, { status: 404 });

  const result = await deleteModifierGroup(location.id, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, deactivated: result.deactivated ?? false });
});
