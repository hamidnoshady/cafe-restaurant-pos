import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { updateMenuItem } from "@/lib/menu-service";
import { validateMenuItemPatch } from "@/lib/menu-validation";
import { resolveActiveLocation } from "@/lib/setup-state";

async function ownedItem(locationId: string, id: string) {
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM menu_items WHERE id = $1 AND location_id = $2",
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
  if (!(await ownedItem(location.id, id)))
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const input = validateMenuItemPatch(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const result = await updateMenuItem(location.id, id, input.value, session.businessId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
});

/** Items referenced by an order are deactivated, not deleted, to keep order history intact. */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownedItem(location.id, id)))
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const { rows: refs } = await query("SELECT id FROM order_items WHERE menu_item_id = $1 LIMIT 1", [id]);
  if (refs.length > 0) {
    await query("UPDATE menu_items SET is_active = false WHERE id = $1", [id]);
    return NextResponse.json({ ok: true, deactivated: true });
  }
  await query("DELETE FROM menu_items WHERE id = $1", [id]);
  return NextResponse.json({ ok: true, deactivated: false });
});
