import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { addStone, getItem } from "@/lib/items-service";
import { recordItemEvent } from "@/lib/item-audit-service";

export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const item = await getItem(id);
  if (!item || item.locationId !== location.id) {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }

  let body: { stoneType?: string; carat?: string; cost?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const stone = await addStone(id, {
      stoneType: body.stoneType ?? "",
      carat: body.carat ?? "",
      cost: Number(body.cost),
    });
    await recordItemEvent({
      businessId: session.businessId,
      locationId: location.id,
      itemId: id,
      eventType: "item.stone_added",
      payload: { stoneId: stone.id, stoneType: stone.stoneType, carat: stone.carat, cost: stone.cost },
      createdBy: session.sub,
    });
    return NextResponse.json({ ok: true, stone });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
