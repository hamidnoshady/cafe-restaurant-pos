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
import { getOnlinePlatformsConfig } from "@/lib/online-platforms-service";
import { lockOpenOrder } from "@/lib/order-lock";
import { paymentFailureFor } from "@/lib/order-payment-errors";
import { rialBigInt, rialText, type RialText } from "@/lib/inventory-exact";
import { tendersWithTip, validateTenders, type ResolvedTender } from "@/lib/payment-methods";
import { listPaymentMethods } from "@/lib/payment-methods-service";

interface PayTenderBody {
  /** `payment_methods.id` — the way the cashier tapped. */
  methodId?: string;
  /** The way's code (`cash`, `card`, …) — accepted so a caller that knows only the built-in names can still pay. */
  method?: string;
  amount?: number;
  reference?: string;
}

interface PayBody {
  /**
   * A bill split across payment ways (migration 0091): ۲۰۰٬۰۰۰ نقدی plus
   * ۳۰۰٬۰۰۰ کارت‌خوان. The slices must add up to the order total plus the tip
   * — see validateTenders for why that is exact rather than "at least".
   */
  payments?: PayTenderBody[];
  /** The single-way form, still sent by the amendment screen and by older clients. */
  method?: string;
  methodId?: string;
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
 * src/lib/table-session-service.ts's closeSession comment). Since migration
 * 0091 one order may be settled across several payment ways at once — ۲۰۰٬۰۰۰
 * نقدی plus ۳۰۰٬۰۰۰ کارت‌خوان is one checkout, one `payments` row per slice,
 * and one journal entry with a debit line per slice. What has not changed is
 * that a checkout settles the bill *in full*: the slices must add up to the
 * total plus the tip, so there is still no partial payment and no balance left
 * open. (A dine-in table session's "split the bill" flow (Phase 3,
 * /api/table-sessions/[id]/split) is a different thing again: it cuts one
 * table's bill into several orders, each of which is then paid here.)
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
  const customerId = body.customerId?.trim() || null;
  const tipAmount = body.tipAmount ?? 0;
  if (!Number.isSafeInteger(tipAmount) || tipAmount < 0) {
    return NextResponse.json({ error: "invalid_tip_amount" }, { status: 400 });
  }

  // One shape from here down: the single-method body is just a split of one
  // slice whose amount is "whatever is owed", so nothing below this line has
  // to know which form the client sent.
  const rawTenders: PayTenderBody[] = body.payments?.length
    ? body.payments
    : [{ methodId: body.methodId, method: body.method, reference: body.reference }];
  if (!Array.isArray(rawTenders) || rawTenders.length === 0) {
    return NextResponse.json({ error: "no_payment" }, { status: 400 });
  }

  // Resolving each slice against the business's *active* ways is what stops a
  // caller paying by a way that belongs to another tenant, or by one this
  // business retired — the id alone proves nothing.
  const available = await listPaymentMethods(session.businessId);
  const byId = new Map(available.map((paymentMethod) => [paymentMethod.id, paymentMethod]));
  const byCode = new Map(available.map((paymentMethod) => [paymentMethod.code, paymentMethod]));
  const resolvedWays = rawTenders.map((tender) =>
    tender.methodId ? byId.get(tender.methodId) : tender.method ? byCode.get(tender.method) : undefined,
  );
  if (resolvedWays.some((way) => !way)) {
    return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
  }
  const ways = resolvedWays as NonNullable<(typeof resolvedWays)[number]>[];
  const missingReference = ways.findIndex(
    (way, index) => way.requiresReference && !rawTenders[index].reference?.trim(),
  );
  if (missingReference >= 0) {
    return NextResponse.json({ error: "payment_reference_required" }, { status: 400 });
  }
  if (ways.some((way) => way.settlement === "credit") && !customerId) {
    return NextResponse.json({ error: "customer_required" }, { status: 400 });
  }

  const client = await getPool().connect();
  let total = "0" as RialText;
  /** The slices actually recorded — read after the transaction, for the response. */
  let paid: ResolvedTender[] = [];
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
    // The tenders cover the bill. A tip is *not* part of it: `payments` rows
    // have always recorded the bill alone (orders.tip_amount holds the tip,
    // and the ledger debits it on top), and every downstream reader — the
    // closed-order amendment's re-plan, a refund's ceiling — depends on that
    // still being true now that there can be several rows. `tendersWithTip`
    // is where the tip rejoins the money for the posting.
    const due = Number(rialBigInt(total));
    let tenders: ResolvedTender[] = [];
    if (due > 0) {
      const validated = validateTenders(
        ways.map((way, index) => ({
          methodId: way.id,
          settlement: way.settlement,
          // A slice with no amount takes whatever is left — the whole bill when
          // it is the only one (the shape every caller sent before splitting
          // existed), and the remainder on a split. See TenderInput.amount.
          amount: rawTenders[index].amount,
          reference: rawTenders[index].reference,
        })),
        { due, hasCustomer: Boolean(customerId) },
      );
      if (!validated.ok) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: validated.error }, { status: 400 });
      }
      tenders = validated.value;
    }
    paid = tenders;
    for (const tender of tenders) {
      await client.query(
        `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by, payment_method_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [location.id, id, tender.settlement, String(tender.amount), tender.reference, session.sub, tender.methodId],
      );
    }
    const { rowCount: completed } = await client.query(
      `UPDATE orders SET status = 'completed', closed_by = $2, closed_at = now(), tip_amount = $3
        WHERE id = $1 AND status = 'open'
        RETURNING id`,
      [id, session.sub, tipAmount],
    );
    if (completed !== 1) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "order_not_open" }, { status: 409 });
    }
    const { totalCost } = await deductForOrder(client, session.businessId, location.id, id, session.sub, inventoryEventId);
    // The commission % lives in settings (it varies by SnapFood contract,
    // per issue #160 §4) — resolved here to a Rial amount, same shape as
    // tipAmount, so the ledger layer never has to know about % or settings.
    // On a split, the commission is taken from the SnapFood slice alone —
    // the cash the customer handed over at the door is not SnapFood's to
    // keep a percentage of.
    let platformCommission = "0" as RialText;
    const platformAmount = tenders
      .filter((tender) => tender.settlement === "snappfood")
      .reduce((sum, tender) => sum + tender.amount, 0);
    if (platformAmount > 0) {
      const { snappfood } = await getOnlinePlatformsConfig(session.businessId);
      if (snappfood) {
        const commissionRial = BigInt(Math.round(platformAmount * (snappfood.commissionPercent / 100)));
        platformCommission = rialText(commissionRial.toString());
      }
    }
    await postExactOrderPaymentEntry(client, {
      businessId: session.businessId,
      locationId: location.id,
      orderId: id,
      createdBy: session.sub,
      tenders: tendersWithTip(tenders, tipAmount).map((tender) => ({
        settlement: tender.settlement,
        amount: rialText(String(tender.amount)),
      })),
      amount: total,
      tax: rialText(order.tax),
      inventoryEventId,
      orderChannel: order.type,
      tip: rialText(String(tipAmount)),
      platformCommission,
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
    // A locked period, a negative ingredient requirement or a costing conflict
    // is a condition someone can go and fix; only an unrecognised fault stays a
    // 500, so it still surfaces as a bug rather than as advice to retry.
    const failure = paymentFailureFor(err);
    if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status });
    throw err;
  } finally {
    client.release();
  }

  broadcast(location.id, { type: "order.updated", orderId: id });
  return NextResponse.json({
    ok: true,
    amount: total,
    // `method` is the settlement of the first slice — kept so a client written
    // against the single-payment response (which is every client that doesn't
    // split) reads the same field it always did.
    method: paid[0]?.settlement ?? null,
    payments: paid.map((tender) => ({
      methodId: tender.methodId,
      method: tender.settlement,
      amount: tender.amount,
      reference: tender.reference,
    })),
    tipAmount,
  });
});
