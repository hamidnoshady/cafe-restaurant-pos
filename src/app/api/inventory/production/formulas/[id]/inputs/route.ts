import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { positiveQuantityText } from "@/lib/inventory-exact";
import { deleteFormulaInput, ProductionError, setFormulaInput } from "@/lib/production-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/** Upsert one input line: how much of an inventory item ONE batch of the formula consumes. */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
    if (error) return error;
    const { id } = await context.params;

    let body: { inventoryItemId?: string; quantity?: number | string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    if (!body.inventoryItemId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    let quantity;
    try {
      quantity = positiveQuantityText(String(body.quantity ?? ""));
    } catch {
      return NextResponse.json({ error: "invalid_item" }, { status: 400 });
    }

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    try {
      await setFormulaInput({
        locationId: location.id,
        formulaId: id,
        inventoryItemId: body.inventoryItemId,
        quantity,
      });
      return NextResponse.json({ ok: true });
    } catch (err) {
      if (err instanceof ProductionError) {
        // A cycle is a conflict with the formulas that already exist, not a
        // malformed request — the caller cannot fix it by resending.
        return NextResponse.json({ error: err.code }, { status: err.code === "formula_cycle" ? 409 : 404 });
      }
      throw err;
    }
  },
);

export const DELETE = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
    if (error) return error;
    const { id } = await context.params;

    const inventoryItemId = new URL(request.url).searchParams.get("inventoryItemId");
    if (!inventoryItemId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    await deleteFormulaInput({ locationId: location.id, formulaId: id, inventoryItemId });
    return NextResponse.json({ ok: true });
  },
);
