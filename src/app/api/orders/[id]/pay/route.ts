import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";
import { paymentFailureFor } from "@/lib/order-payment-errors";
import {
  completeOrderPayment,
  PAYMENT_METHODS,
  paymentErrorDetails,
  type PaymentMethod,
} from "@/lib/payment-service";

interface PayBody {
  method?: string;
  reference?: string;
  customerId?: string;
  /** A tip collected alongside the bill (issue #160 §4), in whole Rial — added on top of the order total, never part of revenue. */
  tipAmount?: number;
}

/**
 * Checkout: records the payment and completes the order. This is the
 * "payment completion" trigger Phase 5's cash-drawer/receipt exit criteria
 * hook into — nothing in the app reached order status 'completed' before
 * this (the table-session `close` action just frees the table; see
 * src/lib/table-session-service.ts's closeSession comment). v1 keeps this
 * simple: one full payment per order, no split/partial payments — a
 * dine-in table session's "split the bill" flow (Phase 3,
 * /api/table-sessions/[id]/split) computes shares for display, but each
 * share is still collected as its own order-level payment.
 *
 * This is also the inventory deduction trigger (Phase 6): completing an
 * order is the one place order_items become immutable (they can only be
 * added/voided/requantified while status = 'open'), so it's the only
 * correct, exactly-once point to consume recipe ingredients. Payment
 * recording, order completion, and deduction all happen in one transaction.
 *
 * Same transaction also posts two Phase 7 journal entries: the payment
 * itself (Debit Cash/Bank-Clearing/Accounts-Receivable — or, for a SnapFood
 * order (issue #160 §4), Receivable-from-Online-Platforms net of SnapFood's
 * commission, with the commission itself debited to its own expense account
 * — for the bill *plus* any tip / Credit the order's channel-specific Sales
 * Revenue account, split by orders.type since Phase 22 Wave 4 — + Tax
 * Payable + Tips Payable if a tip was collected, issue #160 §4 — a
 * pass-through liability, never revenue) and the COGS entry from the
 * deduction's total cost (Debit COGS / Credit Inventory Asset).
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: PayBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const method = body.method as PaymentMethod;
  if (!PAYMENT_METHODS.includes(method)) {
    return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
  }
  const customerId = body.customerId?.trim() || null;
  if (method === "credit" && !customerId) {
    return NextResponse.json({ error: "customer_required" }, { status: 400 });
  }
  const tipAmount = body.tipAmount ?? 0;
  if (!Number.isSafeInteger(tipAmount) || tipAmount < 0) {
    return NextResponse.json({ error: "invalid_tip_amount" }, { status: 400 });
  }

  const client = await getPool().connect();
  let total = "0";
  try {
    await client.query("BEGIN");
    const result = await completeOrderPayment({
      client,
      businessId: session.businessId,
      locationId: location.id,
      orderId: id,
      method,
      reference: body.reference,
      customerId,
      tipAmount,
      receivedBy: session.sub,
    });
    total = result.amount;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    const details = paymentErrorDetails(err);
    if (details) return NextResponse.json({ error: details.error }, { status: details.status });
    const failure = paymentFailureFor(err);
    if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status });
    throw err;
  } finally {
    client.release();
  }

  broadcast(location.id, { type: "order.updated", orderId: id });
  return NextResponse.json({ ok: true, amount: total, method, tipAmount });
});
