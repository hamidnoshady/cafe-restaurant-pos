import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { validatePaymentMethodInput } from "@/lib/payment-methods";
import { createPaymentMethod, listPaymentMethods, reorderPaymentMethods } from "@/lib/payment-methods-service";

/** Every way, retired ones included — the settings tab manages what the till only reads. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  return NextResponse.json({
    paymentMethods: await listPaymentMethods(session.businessId, { includeInactive: true }),
  });
});

/** Adds a way of the business's own — a wallet, a second terminal, a house account. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = validatePaymentMethodInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  return NextResponse.json({ paymentMethod: await createPaymentMethod(session.businessId, parsed.value) }, { status: 201 });
});

/**
 * Rewrites the display order in one shot — the order the cashier's grid is
 * laid out in. Sent whole rather than as a per-row `sortOrder` so a failed
 * second request can't leave two ways sharing a position.
 */
export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: { order?: unknown };
  try {
    body = (await request.json()) as { order?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const order = body.order;
  if (!Array.isArray(order) || order.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  await reorderPaymentMethods(session.businessId, order as string[]);
  return NextResponse.json({
    paymentMethods: await listPaymentMethods(session.businessId, { includeInactive: true }),
  });
});
