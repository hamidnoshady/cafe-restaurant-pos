import { NextRequest, NextResponse } from "next/server";
import { type SessionPayload, withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem, getSerial, updateSerial } from "@/lib/items-service";
import { getSerialWarranty } from "@/lib/watch-sales-service";
import { listRepairsForSerial } from "@/lib/repairs-service";
import { recordItemEvent } from "@/lib/item-audit-service";

/** A unit is only this caller's if its model lives at the branch they're scoped to. */
async function ownedSerial(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const serial = await getSerial(id);
  if (!serial) return null;
  const item = await getItem(serial.itemId);
  if (!item || item.locationId !== location.id) return null;
  return serial;
}

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;
  const { id } = await context.params;

  const serial = await ownedSerial(session, id);
  if (!serial) return NextResponse.json({ error: "serial_not_found" }, { status: 404 });

  const [warranty, repairs] = await Promise.all([getSerialWarranty(id), listRepairsForSerial(id)]);
  return NextResponse.json({ serial, warranty, repairs });
});

/** Edits the cost basis / standard warranty term — e.g. recording the cost once it's known, mid-intake. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;
  const { id } = await context.params;

  const serial = await ownedSerial(session, id);
  if (!serial) return NextResponse.json({ error: "serial_not_found" }, { status: 404 });

  let body: { unitCost?: number | null; warrantyMonths?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const updated = await updateSerial(id, {
      unitCost: body.unitCost ?? null,
      warrantyMonths: body.warrantyMonths,
    });
    const location = await resolveActiveLocation(session);
    if (location) {
      await recordItemEvent({
        businessId: session.businessId,
        locationId: location.id,
        itemId: serial.itemId,
        eventType: "item.cost_basis_changed",
        payload: {
          serialId: id,
          from: { unitCost: serial.unitCost, warrantyMonths: serial.warrantyMonths },
          to: { unitCost: updated.unitCost, warrantyMonths: updated.warrantyMonths },
        },
        createdBy: session.sub,
      });
    }
    return NextResponse.json({ ok: true, serial: updated });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
