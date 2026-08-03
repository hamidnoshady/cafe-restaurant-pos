import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createItem, listWeightItems, setWeightAttributes } from "@/lib/items-service";
import { validateWeightAttributes } from "@/lib/gold";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ items: [] });

  const items = await listWeightItems(location.id);
  return NextResponse.json({ items });
});

/** Creates a `tracking: 'weight'` jewelry piece and its weight/purity attributes together. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  let body: {
    name?: string;
    sku?: string | null;
    purity?: string;
    grossWeight?: string;
    netWeight?: string;
    unitCostPerGram?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const weightInput = {
    purity: body.purity ?? "",
    grossWeight: body.grossWeight ?? "",
    netWeight: body.netWeight ?? "",
    unitCostPerGram: body.unitCostPerGram ?? null,
  };
  // Validated up front so a bad weight/purity never leaves behind an item
  // with no weight attributes -- the two writes below aren't wrapped in a
  // transaction, so this is what keeps them from disagreeing.
  const weightErrors = validateWeightAttributes(weightInput);
  if (weightErrors.length > 0) {
    return NextResponse.json({ error: "invalid_weight_attributes", message: weightErrors.join("؛ ") }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const item = await createItem({
    locationId: location.id,
    name,
    sku: body.sku ?? null,
    tracking: "weight",
  });
  await setWeightAttributes(item.id, weightInput);
  return NextResponse.json({ ok: true, id: item.id });
});
