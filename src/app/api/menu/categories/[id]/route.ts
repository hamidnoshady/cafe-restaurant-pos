import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { updateCategory } from "@/lib/menu-service";
import { validateCategoryPatch } from "@/lib/menu-validation";
import { resolveActiveLocation } from "@/lib/setup-state";

async function ownedCategory(locationId: string, id: string) {
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM menu_categories WHERE id = $1 AND location_id = $2",
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
  if (!(await ownedCategory(location.id, id)))
    return NextResponse.json({ error: "category_not_found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const input = validateCategoryPatch(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const result = await updateCategory(location.id, id, input.value);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
});

/**
 * Categories with items are deactivated, not deleted, so historical orders keep their references.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownedCategory(location.id, id)))
    return NextResponse.json({ error: "category_not_found" }, { status: 404 });

  const { rows: items } = await query("SELECT id FROM menu_items WHERE category_id = $1 LIMIT 1", [id]);
  if (items.length > 0) {
    await query("UPDATE menu_categories SET is_active = false WHERE id = $1", [id]);
    return NextResponse.json({ ok: true, deactivated: true });
  }
  await query("DELETE FROM menu_categories WHERE id = $1", [id]);
  return NextResponse.json({ ok: true, deactivated: false });
});
