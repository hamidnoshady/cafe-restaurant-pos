import { NextRequest, NextResponse } from "next/server";
import { type SessionPayload, withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem, getWeightAttributes, listStones, setWeightAttributes } from "@/lib/items-service";
import { getConsignment } from "@/lib/consignment-service";
import { validateWeightAttributes } from "@/lib/gold";
import { recordItemEvent } from "@/lib/item-audit-service";

async function ownedWeightItem(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const item = await getItem(id);
  if (!item || item.locationId !== location.id || item.tracking !== "weight") return null;
  return item;
}

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;
  const { id } = await context.params;

  const item = await ownedWeightItem(session, id);
  if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const [weightAttrs, stones, consignment] = await Promise.all([
    getWeightAttributes(id),
    listStones(id),
    getConsignment(id),
  ]);
  return NextResponse.json({ item, weightAttrs, stones, consignment });
});

/** Updates weight/purity/cost basis -- e.g. setting the cost basis once it's known, mid-intake. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;
  const { id } = await context.params;

  const item = await ownedWeightItem(session, id);
  if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  let body: { purity?: string; grossWeight?: string; netWeight?: string; unitCostPerGram?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const current = await getWeightAttributes(id);
  if (!current) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const input = {
    purity: body.purity ?? current.purity,
    grossWeight: body.grossWeight ?? current.grossWeight,
    netWeight: body.netWeight ?? current.netWeight,
    unitCostPerGram: body.unitCostPerGram !== undefined ? body.unitCostPerGram : current.unitCostPerGram,
  };
  const weightErrors = validateWeightAttributes(input);
  if (weightErrors.length > 0) {
    return NextResponse.json({ error: "invalid_weight_attributes", message: weightErrors.join("؛ ") }, { status: 400 });
  }

  const weightAttrs = await setWeightAttributes(id, input);
  await recordItemEvent({
    businessId: session.businessId,
    locationId: item.locationId,
    itemId: id,
    eventType: "item.cost_basis_changed",
    payload: {
      from: { grossWeight: current.grossWeight, netWeight: current.netWeight, unitCostPerGram: current.unitCostPerGram },
      to: { grossWeight: weightAttrs.grossWeight, netWeight: weightAttrs.netWeight, unitCostPerGram: weightAttrs.unitCostPerGram },
    },
    createdBy: session.sub,
  });
  return NextResponse.json({ ok: true, weightAttrs });
});
