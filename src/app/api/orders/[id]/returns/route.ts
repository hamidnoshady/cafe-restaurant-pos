import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { positiveQuantityText, rialText } from "@/lib/inventory-exact";
import { createCustomerReturn } from "@/lib/customer-return-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { recordNotification } from "@/lib/notification-events";
import { notificationDedupeKey } from "@/lib/notifications";
import { tomanText } from "@/lib/ai-labels";

export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.paymentsRefund);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  let body: {
    refundMethod?: "cash" | "card" | "card_to_card" | "online" | "credit";
    refundAmountRial?: string;
    reason?: string;
    idempotencyKey?: string;
    lines?: Array<{ orderItemId?: string; quantity?: string; disposition?: "restockable" | "discarded" }>;
  };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { id } = await context.params;
    const result = await createCustomerReturn(client, {
      businessId: session.businessId, locationId: location.id, orderId: id,
      refundMethod: body.refundMethod ?? "cash", refundAmount: rialText(body.refundAmountRial ?? ""),
      reason: body.reason ?? "", idempotencyKey: body.idempotencyKey ?? "", createdBy: session.sub,
      sync: { actorRole: session.role },
      lines: (body.lines ?? []).map((line) => ({
        orderItemId: line.orderItemId ?? "", quantity: positiveQuantityText(line.quantity ?? ""),
        disposition: line.disposition ?? "discarded",
      })),
    });
    await client.query("COMMIT");

    // Only a genuinely new return notifies. `createCustomerReturn` is
    // idempotent on its key and reports a replay as `duplicate`, so a retried
    // request must not put a second card on the owner's phone about one refund.
    if (!result.duplicate) {
      await recordNotification({
        businessId: session.businessId,
        locationId: location.id,
        eventKey: "payment.refunded",
        severity: "important",
        title: "برگشت وجه به مشتری",
        body: `${tomanText(Number(result.refundAmount))}${body.reason?.trim() ? ` — ${body.reason.trim()}` : ""}`,
        url: "/accounting/orders",
        amountRial: Number(result.refundAmount),
        dedupeKey: notificationDedupeKey("payment.refunded", result.id),
        payload: { orderId: id, returnId: result.id },
      });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (caught) {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: (caught as Error).message }, { status: 409 });
  } finally { client.release(); }
});
