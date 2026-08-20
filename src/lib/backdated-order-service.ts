/**
 * Back-dated orders — the DB-touching half.
 *
 * Records a sale that already happened: the paper bills from the evening the
 * POS was down, or the week of trading that predates the install. One
 * transaction opens the order, fills it, settles it and posts it, exactly as
 * the till's own create-then-pay pair does — the difference is that every
 * timestamp it writes is the instant the sale *happened* rather than `now()`:
 *
 *   * `orders.opened_at` / `closed_at`, which is what every day-bucketed
 *     report reads through `app_business_date` (migration 0076), so the sale
 *     lands on the trading day it belongs to — including for a branch whose
 *     day starts at 18:00;
 *   * `stock_movements.occurred_at`, via `deductForOrder`'s `occurredAt` (the
 *     same parameter a closed-order amendment already passes), so the stock
 *     ledger agrees with the sales one; and
 *   * `journal_entries.entry_date`, via `postExact*`'s `entryDate`, which is
 *     also what puts the posting under migration 0024's fiscal-period lock for
 *     the *back-dated* month rather than the current one. A closed month
 *     refuses the sale instead of quietly absorbing it, and that refusal
 *     surfaces as `fiscal_period_locked`.
 *
 * Three things are deliberately *not* back-dated:
 *
 *   * the order number, which comes off the branch's ordinary counter. Numbers
 *     are the sequence bills were issued in, not a second date; renumbering to
 *     slot a late entry into last week's run would rewrite bills that have
 *     already been printed and handed over.
 *   * the table. A back-dated dine-in sale carries `type = 'dine_in'` as a
 *     channel label but never a `table_id`: seating is live floor state, and
 *     occupying table 4 tonight because of a bill from last Tuesday would be a
 *     lie the floor screen has no way to correct.
 *   * `backdated_orders.created_at`, which is when it was actually typed in —
 *     the one honest wall clock in the row, and the reason the table exists.
 */
import type { PoolClient } from "pg";
import { businessDateOf, type ValidatedBackdatedOrder } from "./backdated-orders";
import { deductForOrder } from "./inventory-service";
import { rialText, type RialText } from "./inventory-exact";
import { postExactCogsEntry, postExactOrderPaymentEntry } from "./ledger-service";
import { getOnlinePlatformsConfig } from "./online-platforms-service";
import { captureInventorySnapshot } from "./order-mutations";
import { resolveCartItems } from "./order-cart";
import { computeOrderTotals } from "./orders";
import { tendersWithTip, validateTenders, type ResolvedTender } from "./payment-methods";
import { listPaymentMethods } from "./payment-methods-service";
import { businessIdForLocation, monthlyOrderCount, planLimitsFor } from "./plan-limits";

export class BackdatedOrderError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export interface RecordBackdatedOrderInput {
  businessId: string;
  locationId: string;
  actorId: string | null;
  input: ValidatedBackdatedOrder;
}

export interface RecordBackdatedOrderResult {
  orderId: string;
  orderNumber: number;
  /** The trading day the sale was posted on — what the screen reports back. */
  entryDate: string;
  total: number;
  payments: ResolvedTender[];
}

interface BranchRow extends Record<string, unknown> {
  timezone: string;
  business_day_start_minutes: number | null;
}

/**
 * Records one past sale. Runs inside the caller's transaction — the route owns
 * BEGIN/COMMIT, the same way the amendment route does, so a failed posting
 * takes the order and its stock movements with it.
 */
export async function recordBackdatedOrder(
  client: PoolClient,
  params: RecordBackdatedOrderInput,
): Promise<RecordBackdatedOrderResult> {
  const { businessId, locationId, actorId, input } = params;
  const occurredAtIso = input.occurredAt.toISOString();

  const { rows: branchRows } = await client.query<BranchRow>(
    `SELECT timezone, business_day_start_minutes FROM locations WHERE id = $1 AND business_id = $2`,
    [locationId, businessId],
  );
  if (branchRows.length === 0) throw new BackdatedOrderError("no_location", 409);
  const entryDate = businessDateOf(
    input.occurredAt,
    branchRows[0].timezone,
    branchRows[0].business_day_start_minutes,
  );

  // A back-dated sale is still a sale against the plan's monthly allowance —
  // the same check createOrder makes, made here because this path does not go
  // through it.
  const planBusinessId = await businessIdForLocation(locationId, client);
  if (planBusinessId) {
    const limits = await planLimitsFor(planBusinessId, client);
    if (
      limits.monthlyOrderLimit !== null &&
      (await monthlyOrderCount(planBusinessId, client)) >= limits.monthlyOrderLimit
    ) {
      throw new BackdatedOrderError("monthly_order_limit_exceeded", 403);
    }
  }

  if (input.customerId) {
    const { rowCount } = await client.query(`SELECT 1 FROM customers WHERE id = $1 AND business_id = $2`, [
      input.customerId,
      businessId,
    ]);
    if (rowCount !== 1) throw new BackdatedOrderError("customer_not_found", 404);
  }

  // Settlement ways, resolved against the business's own *active* ways
  // (migration 0091) exactly as the checkout route resolves them — an id alone
  // proves neither that the way is this tenant's nor that it is still offered.
  // Resolved before anything is written, because listPaymentMethods reads (and
  // lazily seeds) through the pool rather than this transaction's connection.
  const available = await listPaymentMethods(businessId);
  const byId = new Map(available.map((way) => [way.id, way]));
  const byCode = new Map(available.map((way) => [way.code, way]));
  const ways = input.payments.map((tender) =>
    tender.methodId ? byId.get(tender.methodId) : tender.method ? byCode.get(tender.method) : undefined,
  );
  if (ways.some((way) => !way)) throw new BackdatedOrderError("invalid_payment_method", 400);
  const resolvedWays = ways as NonNullable<(typeof ways)[number]>[];
  if (resolvedWays.some((way) => way.settlement === "credit") && !input.customerId) {
    throw new BackdatedOrderError("customer_required", 400);
  }

  const resolved = await resolveCartItems(
    locationId,
    input.lines.map((line) => ({
      menuItemId: line.menuItemId,
      quantity: line.quantity,
      note: line.note ?? undefined,
      modifierIds: line.modifierIds,
    })),
    client,
  );
  if (!resolved.ok) throw new BackdatedOrderError(resolved.error, resolved.status);
  const totals = computeOrderTotals(resolved.cartLines, input.discount, 0);

  const { rows: counter } = await client.query<{ next_number: string }>(
    `INSERT INTO order_number_counters (location_id, next_number) VALUES ($1, 2)
     ON CONFLICT (location_id) DO UPDATE SET next_number = order_number_counters.next_number + 1
     RETURNING next_number - 1 AS next_number`,
    [locationId],
  );
  const orderNumber = Number(counter[0].next_number);

  // Opened, filled, then completed — in that order, and for the reason
  // retail-invoice-service.ts states: `guard_order_item_mutation`
  // (migration 0014) refuses a line on an order that is not 'open', which is
  // the invariant that makes a settled sale immutable. A back-dated order has
  // no open stage anyone ever saw, but it still passes through the state the
  // guard requires.
  const { rows: orderRows } = await client.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, customer_id,
            subtotal, discount, discount_type, discount_value, service_charge, tax, total, note,
            opened_by, opened_at)
     VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, 0, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      locationId,
      orderNumber,
      input.type,
      input.customerId,
      totals.subtotal,
      totals.discount,
      input.discount.type,
      input.discount.type ? input.discount.value : null,
      totals.tax,
      totals.total,
      input.note,
      actorId,
      occurredAtIso,
    ],
  );
  const orderId = orderRows[0].id;

  for (const item of resolved.preparedItems) {
    // 'served', not 'sent': the kitchen made this hours or days ago. Leaving it
    // 'sent' would be a lie the KDS could not clear, and would put a finished
    // sale into the kitchen's own throughput figures as an outstanding ticket.
    const { rows: itemRows } = await client.query<{ id: string }>(
      `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, note,
              status, sent_to_kitchen_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'served', $8, $8) RETURNING id`,
      [locationId, orderId, item.menuItemId, item.name, item.unitPrice, item.quantity, item.note, occurredAtIso],
    );
    const orderItemId = itemRows[0].id;
    if (item.modifiers.length > 0) {
      await client.query(
        `INSERT INTO order_item_modifiers (order_item_id, modifier_id, name_snapshot, price_delta)
         SELECT $1, * FROM UNNEST($2::uuid[], $3::text[], $4::bigint[])`,
        [
          orderItemId,
          item.modifiers.map((m) => m.id),
          item.modifiers.map((m) => m.name),
          item.modifiers.map((m) => m.priceDelta),
        ],
      );
    }
    await captureInventorySnapshot(
      client,
      orderItemId,
      item.menuItemId,
      item.modifiers.map((m) => m.id),
    );
  }

  let tenders: ResolvedTender[] = [];
  if (totals.total > 0) {
    const validated = validateTenders(
      resolvedWays.map((way, index) => ({
        methodId: way.id,
        settlement: way.settlement,
        amount: input.payments[index].amount ?? undefined,
        reference: input.payments[index].reference ?? undefined,
      })),
      { due: totals.total, hasCustomer: Boolean(input.customerId) },
    );
    if (!validated.ok) throw new BackdatedOrderError(validated.error, 400);
    tenders = validated.value;
  }

  const { rows: eventRows } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id,location_id,event_type,source_type,source_id,created_by,idempotency_key,costing_version)
     VALUES($1,$2,'sale_consumption','order',$3,$4,'backdated-order:' || $5,2)
     RETURNING id`,
    [businessId, locationId, orderId, actorId, orderId],
  );
  const inventoryEventId = eventRows[0].id;

  // `received_at` is when the money was taken, so it moves with the sale.
  // `settlement_seq` numbers the slices within this one settlement (migration
  // 0092), exactly as the live checkout does.
  for (const [index, tender] of tenders.entries()) {
    await client.query(
      `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by, payment_method_id,
              settlement_seq, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        locationId,
        orderId,
        tender.settlement,
        String(tender.amount),
        tender.reference,
        actorId,
        tender.methodId,
        index + 1,
        occurredAtIso,
      ],
    );
  }

  const { rowCount: completed } = await client.query(
    `UPDATE orders SET status = 'completed', closed_by = $2, closed_at = $3, tip_amount = $4
      WHERE id = $1 AND status = 'open'`,
    [orderId, actorId, occurredAtIso, input.tipAmount],
  );
  if (completed !== 1) throw new BackdatedOrderError("order_not_open", 409);

  const { totalCost } = await deductForOrder(
    client,
    businessId,
    locationId,
    orderId,
    actorId,
    inventoryEventId,
    occurredAtIso,
  );

  let platformCommission = "0" as RialText;
  const platformAmount = tenders
    .filter((tender) => tender.settlement === "snappfood")
    .reduce((sum, tender) => sum + tender.amount, 0);
  if (platformAmount > 0) {
    const { snappfood } = await getOnlinePlatformsConfig(businessId);
    if (snappfood) {
      platformCommission = rialText(
        BigInt(Math.round(platformAmount * (snappfood.commissionPercent / 100))).toString(),
      );
    }
  }

  await postExactOrderPaymentEntry(client, {
    businessId,
    locationId,
    orderId,
    createdBy: actorId,
    tenders: tendersWithTip(tenders, input.tipAmount).map((tender) => ({
      settlement: tender.settlement,
      amount: rialText(String(tender.amount)),
    })),
    amount: rialText(String(totals.total)),
    tax: rialText(String(totals.tax)),
    inventoryEventId,
    orderChannel: input.type,
    tip: rialText(String(input.tipAmount)),
    platformCommission,
    entryDate,
  });
  await postExactCogsEntry(client, {
    businessId,
    locationId,
    orderId,
    createdBy: actorId,
    totalCost,
    inventoryEventId,
    entryDate,
  });
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [inventoryEventId]);

  await client.query(
    `INSERT INTO backdated_orders (business_id, location_id, order_id, occurred_at, entry_date, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [businessId, locationId, orderId, occurredAtIso, entryDate, input.reason, actorId],
  );

  // Phase 9's central rollup re-pushes only the last couple of days
  // (RESEND_OVERLAP_DAYS), so a sale entered for an older day would never reach
  // a central server on its own. Winding the push high-water mark back to that
  // day puts it in the next push window; the ingest side is an idempotent
  // per-day upsert, so the day simply converges. Same reasoning, and the same
  // statement, as a closed-order amendment's (order-amendment-service.ts).
  await client.query(
    `UPDATE settings
        SET value = jsonb_set(value, '{lastSuccessDay}', to_jsonb($2::text)), updated_at = now()
      WHERE business_id = $1 AND location_id IS NULL AND key = 'rollup.sync_state'
        AND value->>'lastSuccessDay' IS NOT NULL
        AND value->>'lastSuccessDay' > $2`,
    [businessId, entryDate],
  );

  await client.query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1,$2,$3,'order.backdated','order',$4,$5)`,
    [
      businessId,
      locationId,
      actorId,
      orderId,
      JSON.stringify({
        occurredAt: occurredAtIso,
        entryDate,
        reason: input.reason,
        orderNumber,
        total: totals.total,
        tipAmount: input.tipAmount,
      }),
    ],
  );

  return { orderId, orderNumber, entryDate, total: totals.total, payments: tenders };
}

export interface BackdatedOrderRow {
  id: string;
  orderId: string;
  orderNumber: number;
  occurredAt: string;
  entryDate: string;
  reason: string;
  total: number;
  recordedAt: string;
  recordedByName: string | null;
}

/** The branch's recent back-dated entries, newest sale first. */
export async function listBackdatedOrders(
  client: PoolClient,
  locationId: string,
  limit = 50,
): Promise<BackdatedOrderRow[]> {
  const { rows } = await client.query<{
    id: string;
    order_id: string;
    order_number: string;
    occurred_at: string;
    entry_date: string;
    reason: string;
    total: string;
    created_at: string;
    recorded_by_name: string | null;
  }>(
    `SELECT b.id, b.order_id, o.order_number, b.occurred_at, b.entry_date::text AS entry_date,
            b.reason, o.total, b.created_at, u.full_name AS recorded_by_name
       FROM backdated_orders b
       JOIN orders o ON o.id = b.order_id
       LEFT JOIN users u ON u.id = b.created_by
      WHERE b.location_id = $1
      ORDER BY b.occurred_at DESC
      LIMIT $2`,
    [locationId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    orderNumber: Number(row.order_number),
    occurredAt: row.occurred_at,
    entryDate: row.entry_date,
    reason: row.reason,
    total: Number(row.total),
    recordedAt: row.created_at,
    recordedByName: row.recorded_by_name,
  }));
}
