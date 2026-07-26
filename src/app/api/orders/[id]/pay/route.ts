import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";
import { deductForOrder } from "@/lib/inventory-service";
import {
  MissingLedgerAccountError,
  postExactCogsEntry,
  postExactOrderPaymentEntry,
} from "@/lib/ledger-service";
import { lockOpenOrder } from "@/lib/order-lock";
import { rialBigInt, rialText, type RialText } from "@/lib/inventory-exact";

const PAYMENT_METHODS = ["cash", "card", "card_to_card", "online", "credit"] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

interface PayBody {
  method?: string;
  reference?: string;
  customerId?: string;
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

  const client = await getPool().connect();
  let total = "0" as RialText;
  try {
    await client.query("BEGIN");
    const locked = await lockOpenOrder(client, location.id, id);
    if (!locked.ok) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: locked.error }, { status: locked.status });
    }
    const order = locked.order;
    if (customerId) {
      const { rowCount: customerOwned } = await client.query(
        `SELECT 1 FROM customers WHERE id = $1 AND business_id = $2`,
        [customerId, session.businessId],
      );
      if (customerOwned !== 1) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
      }
      await client.query(`UPDATE orders SET customer_id = $1 WHERE id = $2`, [customerId, id]);
    }
    const { rows: eventRows } = await client.query<{id:string}>(
      `INSERT INTO inventory_events
       (business_id,location_id,event_type,source_type,source_id,created_by,idempotency_key,costing_version)
       VALUES($1,$2,'sale_consumption','order',$3,$4,'order-payment:' || $5,2)
       RETURNING id`, [session.businessId,location.id,id,session.sub,id]);
    const inventoryEventId = eventRows[0].id;
    total = rialText(order.total);
    if (rialBigInt(total) > 0n) {
      await client.query(
        `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [location.id, id, method, total, body.reference?.trim() || null, session.sub],
      );
    }
    const { rowCount: completed } = await client.query(
      `UPDATE orders SET status = 'completed', closed_by = $2, closed_at = now()
        WHERE id = $1 AND status = 'open'
        RETURNING id`,
      [id, session.sub],
    );
    if (completed !== 1) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "order_not_open" }, { status: 409 });
    }
    const { totalCost } = await deductForOrder(client, session.businessId, location.id, id, session.sub, inventoryEventId);
    await postExactOrderPaymentEntry(client, {
      businessId: session.businessId,
      locationId: location.id,
      orderId: id,
      createdBy: session.sub,
      method,
      amount: total,
      tax: rialText(order.tax),
      inventoryEventId,
    });
    await postExactCogsEntry(client, {
      businessId: session.businessId,
      locationId: location.id,
      orderId: id,
      createdBy: session.sub,
      totalCost,
      inventoryEventId,
    });
    await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [inventoryEventId]);
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
});
