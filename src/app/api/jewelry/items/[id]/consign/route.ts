import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem } from "@/lib/items-service";
import { markAsConsigned } from "@/lib/consignment-service";

/** Marks an already-created `tracking: 'weight'` item as held for a consignor (امانی) rather than owned by the business. One-time, at intake -- see consignment-service.ts. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
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

  let body: { consignorId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.consignorId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  try {
    const consignment = await markAsConsigned(id, body.consignorId);
    return NextResponse.json({ ok: true, consignment });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
