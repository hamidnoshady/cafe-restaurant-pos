import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { positiveQuantityText, rialText } from "@/lib/inventory-exact";
import { createFormula, listFormulas, ProductionError } from "@/lib/production-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Production formulas (فرمول تولید) — "one batch of this consumes those and
 * yields this much of that item".
 *
 * No feature or module gate is declared here and none is missing: `/api/inventory`
 * already resolves to the `inventory` flag (src/lib/features.ts) and the
 * `inventory` module (src/lib/industry-profile.ts), both enforced in
 * `withTenantScope`, so a business without either never reaches this handler.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ formulas: [] });

  return NextResponse.json({ formulas: await listFormulas(location.id) });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  let body: {
    name?: string;
    outputInventoryItemId?: string;
    outputQuantity?: number | string;
    conversionCostRial?: number | string;
    notes?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name || !body.outputInventoryItemId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  // Quantities and money arrive as text so a caller can send more precision
  // than an IEEE-754 double carries; these are the validators.
  let outputQuantity;
  try {
    outputQuantity = positiveQuantityText(String(body.outputQuantity ?? ""));
  } catch {
    return NextResponse.json({ error: "invalid_yield" }, { status: 400 });
  }
  let conversionCostRial;
  try {
    conversionCostRial = rialText(String(body.conversionCostRial ?? "0"));
  } catch {
    return NextResponse.json({ error: "invalid_conversion_cost" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  try {
    const created = await createFormula({
      businessId: session.businessId,
      locationId: location.id,
      name,
      outputInventoryItemId: body.outputInventoryItemId,
      outputQuantity,
      conversionCostRial,
      notes: body.notes?.trim() || null,
      createdBy: session.sub,
    });
    return NextResponse.json({ ok: true, id: created.id });
  } catch (err) {
    if (err instanceof ProductionError) {
      return NextResponse.json({ error: err.code }, { status: err.code === "output_item_not_found" ? 404 : 409 });
    }
    throw err;
  }
});
