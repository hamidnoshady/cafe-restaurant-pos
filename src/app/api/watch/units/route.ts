import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { addSerial, getItem } from "@/lib/items-service";
import { listSerialUnits } from "@/lib/watch-sales-service";
import { recordItemEvent } from "@/lib/item-audit-service";

/** Every physical unit at this branch, with its model, cost basis and live warranty window. */
  // Cashier included on the read side only: selling from the invoice screen
  // means listing what is in stock, exactly as /api/menu's GET is readable by
  // every floor role. The write handlers below stay owner/manager.
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ units: [] });

  const units = await listSerialUnits(location.id);
  return NextResponse.json({ units });
});

/** Registers one physical unit of a model, with the cost the shop paid and the warranty term it will be sold with. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;

  let body: { itemId?: string; serialNumber?: string; unitCost?: number | null; warrantyMonths?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.itemId || !body.serialNumber?.trim()) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const item = await getItem(body.itemId);
  if (!item || item.locationId !== location.id) {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }

  try {
    const serial = await addSerial(body.itemId, body.serialNumber, {
      unitCost: body.unitCost ?? null,
      warrantyMonths: body.warrantyMonths ?? 0,
    });
    await recordItemEvent({
      businessId: session.businessId,
      locationId: location.id,
      itemId: body.itemId,
      eventType: "item.created",
      payload: { serialId: serial.id, serialNumber: serial.serialNumber, unitCost: serial.unitCost, warrantyMonths: serial.warrantyMonths },
      createdBy: session.sub,
    });
    return NextResponse.json({ ok: true, serial });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
