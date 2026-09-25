import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getSuggestedPrice } from "@/lib/pricing-service";

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuView);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows } = await query("SELECT 1 FROM menu_items WHERE id = $1 AND location_id = $2", [id, location.id]);
  if (rows.length === 0) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const breakdown = await getSuggestedPrice(session.businessId, id);
  if (!breakdown) return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  return NextResponse.json({ suggestion: breakdown });
});
