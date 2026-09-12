import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Delete one visual profile. A profile is scoped twice: by the caller's
 * active branch (the item must live there) and by RLS on business_id, so a
 * wrong-id delete from another branch is a 404, never a success.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const { id } = await context.params;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rowCount } = await query(
    `DELETE FROM inventory_item_visual_profiles p
      USING inventory_items i
      WHERE p.id = $1 AND p.inventory_item_id = i.id AND i.location_id = $2`,
    [id, location.id],
  );
  if (rowCount === 0) return NextResponse.json({ error: "profile_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
