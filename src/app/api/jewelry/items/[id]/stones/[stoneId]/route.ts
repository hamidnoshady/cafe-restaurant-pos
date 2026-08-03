import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem, removeStone } from "@/lib/items-service";

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string; stoneId: string }> }) => {
    const { session, error } = await requireRole("owner", "manager");
    if (error) return error;
    const industryError = await requireIndustryForApi(session, "jewelry");
    if (industryError) return industryError;
    const { id, stoneId } = await context.params;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
    const item = await getItem(id);
    if (!item || item.locationId !== location.id) {
      return NextResponse.json({ error: "item_not_found" }, { status: 404 });
    }

    await removeStone(stoneId);
    return NextResponse.json({ ok: true });
  },
);
