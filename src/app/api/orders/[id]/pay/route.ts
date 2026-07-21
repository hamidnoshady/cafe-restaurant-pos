import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { getPrimaryLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";
import { deductForOrder } from "@/lib/inventory-service";
import { MissingLedgerAccountError, postCogsEntry, postOrderPaymentEntry } from "@/lib/ledger-service";

const PAYMENT_METHODS = ["cash", "card", "card_to_card", "online", "credit"] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

interface PayBody {
  method?: string;
  reference?: string;
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
 * itself (Debit Cash/Bank-Clearing/Accounts-Receivable / Credit Sales
 * Revenue + Tax Payable) and the COGS entry from the deduction's total cost
 * (Debit COGS / Credit Inventory Asset).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const { id } = await context.params;

  const location = await getPrimaryLocation(session.businessId);
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

  const { rows } = await query<{ id: string; status: string; total: string; tax: string }>(
    "SELECT id, status, total, tax FROM orders WHERE id = $1 AND location_id = $2",
    [id, location.id],
  );
  const order = rows[0];
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  if (order.status !== "open") return NextResponse.json({ error: "order_not_open" }, { status: 409 });

  const total = Number(order.total);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (total > 0) {
      await client.query(
        `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [location.id, id, method, total, body.reference?.trim() || null, session.sub],
      );
    }
    await client.query(
      "UPDATE orders SET status = 'completed', closed_by = $2, closed_at = now() WHERE id = $1",
      [id, session.sub],
    );
    const { totalCost } = await deductForOrder(client, session.businessId, location.id, id, session.sub);
    await postOrderPaymentEntry(client, {
      businessId: session.businessId,
      locationId: location.id,
      orderId: id,
      createdBy: session.sub,
      method,
      amount: total,
      tax: Number(order.tax),
    });
    await postCogsEntry(client, {
      businessId: session.businessId,
      locationId: location.id,
      orderId: id,
      createdBy: session.sub,
      totalCost,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    throw err;
  } finally {
    client.release();
  }

  broadcast(location.id, { type: "order.updated", orderId: id });
  return NextResponse.json({ ok: true, amount: total, method });
}
