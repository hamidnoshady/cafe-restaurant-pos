import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { addStone, getItem } from "@/lib/items-service";

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
    return NextResponse.json({ ok: true, stone });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
