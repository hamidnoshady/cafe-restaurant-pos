import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { positiveQuantityText, rialText } from "@/lib/inventory-exact";
import { deleteFormula, ProductionError, updateFormula } from "@/lib/production-service";
import { resolveActiveLocation } from "@/lib/setup-state";

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
    if (error) return error;
    const { id } = await context.params;

    let body: {
      name?: string;
      outputQuantity?: number | string;
      conversionCostRial?: number | string;
      notes?: string | null;
      isActive?: boolean;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    const patch: Parameters<typeof updateFormula>[0] = { locationId: location.id, formulaId: id };
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
      patch.name = name;
    }
    if (body.outputQuantity !== undefined) {
      try {
        patch.outputQuantity = positiveQuantityText(String(body.outputQuantity));
      } catch {
        return NextResponse.json({ error: "invalid_yield" }, { status: 400 });
      }
    }
    if (body.conversionCostRial !== undefined) {
      try {
        patch.conversionCostRial = rialText(String(body.conversionCostRial));
      } catch {
        return NextResponse.json({ error: "invalid_conversion_cost" }, { status: 400 });
      }
    }
    if (body.notes !== undefined) patch.notes = body.notes?.trim() || null;
    if (body.isActive !== undefined) patch.isActive = body.isActive;

    try {
      await updateFormula(patch);
      return NextResponse.json({ ok: true });
    } catch (err) {
      if (err instanceof ProductionError) {
        return NextResponse.json({ error: err.code }, { status: err.code === "bad_request" ? 400 : 404 });
      }
      throw err;
    }
  },
);

/** Deletes the formula, or deactivates it when a posted run already points at it. */
export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
    if (error) return error;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    try {
      const result = await deleteFormula(location.id, id);
      return NextResponse.json({ ok: true, deactivated: result.deactivated });
    } catch (err) {
      if (err instanceof ProductionError) {
        return NextResponse.json({ error: err.code }, { status: 404 });
      }
      throw err;
    }
  },
);
