import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { CUSTOM_PAYMENT_SETTLEMENTS, MAX_PAYMENT_METHOD_NAME, isPaymentSettlement } from "@/lib/payment-methods";
import {
  deletePaymentMethod,
  paymentCountForMethod,
  paymentMethodsByIds,
  updatePaymentMethod,
  type PaymentMethodPatch,
} from "@/lib/payment-methods-service";

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const { id } = await context.params;

  const existing = (await paymentMethodsByIds(session.businessId, [id])).get(id);
  if (!existing) return NextResponse.json({ error: "payment_method_not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const patch: PaymentMethodPatch = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_PAYMENT_METHOD_NAME) {
      return NextResponse.json({ error: "invalid_name" }, { status: 400 });
    }
    patch.name = name;
  }
  if (body.settlement !== undefined) {
    // How a way settles decides which account its money lands in, so changing
    // it after money has arrived would re-describe payments already posted.
    // Renaming and reordering stay open forever; this one closes on first use.
    if (existing.isBuiltin) return NextResponse.json({ error: "builtin_settlement_locked" }, { status: 409 });
    if (!isPaymentSettlement(body.settlement) || !CUSTOM_PAYMENT_SETTLEMENTS.includes(body.settlement)) {
      return NextResponse.json({ error: "invalid_settlement" }, { status: 400 });
    }
    if (body.settlement !== existing.settlement && (await paymentCountForMethod(session.businessId, id)) > 0) {
      return NextResponse.json({ error: "payment_method_in_use" }, { status: 409 });
    }
    patch.settlement = body.settlement;
  }
  for (const key of ["isActive", "opensDrawer", "requiresReference"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }
  if (body.isActive !== undefined) patch.isActive = body.isActive as boolean;
  if (body.opensDrawer !== undefined) patch.opensDrawer = body.opensDrawer as boolean;
  if (body.requiresReference !== undefined) patch.requiresReference = body.requiresReference as boolean;

  const updated = await updatePaymentMethod(session.businessId, id, patch);
  if (!updated) return NextResponse.json({ error: "payment_method_not_found" }, { status: 404 });
  return NextResponse.json({ paymentMethod: updated });
});

/**
 * Deletes a way the business added and never used. A built-in is refused (the
 * app names `cash`, `credit` and `snappfood` by code), and so is a way that
 * already took money — history has to keep reading the way it was recorded.
 * Both cases have the same answer: deactivate it instead, which is what the
 * settings tab offers.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const { id } = await context.params;

  const existing = (await paymentMethodsByIds(session.businessId, [id])).get(id);
  if (!existing) return NextResponse.json({ error: "payment_method_not_found" }, { status: 404 });
  if (existing.isBuiltin) return NextResponse.json({ error: "builtin_payment_method" }, { status: 409 });
  if ((await paymentCountForMethod(session.businessId, id)) > 0) {
    return NextResponse.json({ error: "payment_method_in_use" }, { status: 409 });
  }

  const deleted = await deletePaymentMethod(session.businessId, id);
  if (!deleted) return NextResponse.json({ error: "payment_method_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
