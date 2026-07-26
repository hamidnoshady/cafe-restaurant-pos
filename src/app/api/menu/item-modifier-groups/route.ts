import { NextRequest, NextResponse } from "next/server";
import { requireRole, type SessionPayload, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

async function validatePair(session: SessionPayload, menuItemId: string, modifierGroupId: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return false;
  const { rows } = await query(
    `SELECT 1 FROM menu_items WHERE id = $1 AND location_id = $3
     UNION ALL
     SELECT 1 FROM modifier_groups WHERE id = $2 AND location_id = $3`,
    [menuItemId, modifierGroupId, location.id],
  );
  return rows.length === 2;
}

/** Attach a modifier group to a menu item. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { menuItemId?: string; modifierGroupId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const { menuItemId, modifierGroupId } = body;
  if (!menuItemId || !modifierGroupId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (!(await validatePair(session, menuItemId, modifierGroupId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await query(
    `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [menuItemId, modifierGroupId],
  );
  return NextResponse.json({ ok: true });
});

/** Detach a modifier group from a menu item. */
export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const menuItemId = request.nextUrl.searchParams.get("menuItemId");
  const modifierGroupId = request.nextUrl.searchParams.get("modifierGroupId");
  if (!menuItemId || !modifierGroupId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (!(await validatePair(session, menuItemId, modifierGroupId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await query(
    "DELETE FROM menu_item_modifier_groups WHERE menu_item_id = $1 AND modifier_group_id = $2",
    [menuItemId, modifierGroupId],
  );
  return NextResponse.json({ ok: true });
});
