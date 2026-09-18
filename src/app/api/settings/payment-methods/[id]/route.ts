import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { CUSTOM_PAYMENT_SETTLEMENTS, MAX_PAYMENT_METHOD_NAME, isPaymentSettlement } from "@/lib/payment-methods";
import {
  deletePaymentMethod,
  listPaymentMethods,
  paymentCountForMethod,
  paymentMethodsByIds,
  updatePaymentMethod,
  type PaymentMethodPatch,
} from "@/lib/payment-methods-service";

function booleanPatch(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const { id } = await context.params;

  const existing = (await paymentMethodsByIds(session.businessId, [id])).get(id);
  if (!existing) return NextResponse.json({ error: "payment_method_not_found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;

  const patch: PaymentMethodPatch = {};
  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > MAX_PAYMENT_METHOD_NAME) {
      return NextResponse.json({ error: "invalid_name" }, { status: 400 });
    }
    patch.name = name;
  }
  if (input.settlement !== undefined) {
    // How a way settles decides which account its money lands in, so changing
    // it after money has arrived would re-describe payments already posted.
    // Renaming and reordering stay open forever; this one closes on first use.
    if (existing.isBuiltin) return NextResponse.json({ error: "builtin_settlement_locked" }, { status: 409 });
    if (!isPaymentSettlement(input.settlement) || !CUSTOM_PAYMENT_SETTLEMENTS.includes(input.settlement)) {
      return NextResponse.json({ error: "invalid_settlement" }, { status: 400 });
    }
    if (input.settlement !== existing.settlement && (await paymentCountForMethod(session.businessId, id)) > 0) {
      return NextResponse.json({ error: "payment_method_settlement_locked" }, { status: 409 });
    }
    patch.settlement = input.settlement;
  }
  for (const key of ["isActive", "opensDrawer", "requiresReference"] as const) {
    if (input[key] === undefined) continue;
    const value = booleanPatch(input[key]);
    if (value === null) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (patch.isActive === false && existing.isActive) {
    const all = await listPaymentMethods(session.businessId, { includeInactive: true });
    if (!all.some((method) => method.id !== id && method.isActive)) {
      return NextResponse.json({ error: "last_active_payment_method" }, { status: 409 });
    }
  }

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
  if (existing.isActive) {
    const all = await listPaymentMethods(session.businessId, { includeInactive: true });
    if (!all.some((method) => method.id !== id && method.isActive)) {
      return NextResponse.json({ error: "last_active_payment_method" }, { status: 409 });
    }
  }

  const deleted = await deletePaymentMethod(session.businessId, id);
  if (!deleted) {
    // A checkout may have started using the way after the count above. The
    // atomic DELETE refuses it; report the actionable reason rather than a
    // misleading 404.
    if ((await paymentCountForMethod(session.businessId, id)) > 0) {
      return NextResponse.json({ error: "payment_method_in_use" }, { status: 409 });
    }
    return NextResponse.json({ error: "payment_method_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
});
