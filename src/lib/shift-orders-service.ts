/**
 * Item-by-item order detail for the current shift — the DB-touching half
 * (not unit-tested directly, per repo convention; the grouping rule lives in
 * shift-orders.ts and is covered by shift-orders.test.ts).
 *
 * The default shift is the most recently started one at the branch, open or
 * closed, and its window is [started_at, coalesce(ended_at, now())] — the
 * same expression listShifts' LATERAL join already uses. Deliberately *not*
 * "the newest shift with ended_at IS NULL": that would make the report go
 * blank the moment someone clocks out, and it would silently widen to
 * yesterday's window if an employee forgot to clock out. Taking the newest
 * shift either way means the report covers the shift that is running now, or
 * the one that just finished, and rolls over on its own when the next shift
 * starts — no cleanup, no stored state.
 *
 * The caller can name an earlier one instead (`shiftId`), which is why the
 * report carries the branch's recent shifts as the picker's options. The
 * chosen shift is looked up *within* that list rather than by its own query:
 * the list is already branch-scoped, so a shift id belonging to another
 * branch simply isn't found and reports nothing.
 *
 * Orders are the ones *opened* inside that window, at any status: a shift
 * review is about the work that came in during the shift, including what is
 * still open, held, or was voided. That is a wider net than the shift's cash
 * figures (shiftCashSummary counts only completed orders, by closed_at), so
 * the two are not expected to tie out — see the doc comment on `total` in
 * shift-orders.ts.
 *
 * Each order is read whole — its add-on snapshots by name, its notes and void
 * reasons, its money breakdown, and its payments — so the review answers "why
 * was this order this much?" without sending the reader to the orders screen.
 * Everything comes from the immutable *_snapshot columns written at the sale,
 * never from today's menu, so a renamed or repriced add-on still reads the way
 * it was sold.
 */
import { query } from "./db";
import {
  groupShiftOrders,
  type ShiftOrder,
  type ShiftOrderItemInput,
  type ShiftOrderModifier,
  type ShiftOrderPaymentInput,
} from "./shift-orders";

export interface ShiftOption {
  id: string;
  employeeName: string;
  startedAt: string;
  endedAt: string | null;
}

/**
 * The branch's recent shifts, newest first — the options behind every shift
 * picker (this report's, and the orders screen's since it gained one).
 *
 * A shift whose `location_id` is null is included: a shift only records a
 * branch when the session that opened it had one, so rows written before
 * openShift took a fallback branch have none, and excluding them would hide
 * exactly the shifts a single-branch business worked. Nothing branch-scoped
 * leaks by including them — every caller filters the orders themselves by
 * `location_id`, so an unattributed shift can only ever name a time window.
 */
export async function listRecentShiftOptions(
  locationId: string,
  limit = 50,
): Promise<ShiftOption[]> {
  const { rows } = await query<ShiftWindowRow>(
    `SELECT s.id, u.full_name AS employee_name, s.started_at, s.ended_at
       FROM employee_shifts s
       JOIN users u ON u.id = s.employee_id
      WHERE (s.location_id = $1 OR s.location_id IS NULL)
      ORDER BY s.started_at DESC
      LIMIT $2`,
    [locationId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    employeeName: row.employee_name,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
  }));
}

export interface ShiftOrdersReport {
  shift: ShiftOption;
  /** The branch's recent shifts, newest first — the picker's options, always including `shift`. */
  shifts: ShiftOption[];
  orders: ShiftOrder[];
}

interface ShiftWindowRow extends Record<string, unknown> {
  id: string;
  employee_name: string;
  started_at: Date;
  ended_at: Date | null;
}

interface ShiftOrderItemRow extends Record<string, unknown> {
  order_id: string;
  order_number: string; // bigint — pg returns it as a string

  type: string;
  status: string;
  table_name: string | null;
  guest_count: number | null;
  customer_name: string | null;
  opened_at: Date;
  closed_at: Date | null;
  opened_by_name: string | null;
  closed_by_name: string | null;
  order_note: string | null;
  voided_reason: string | null;
  amended_at: Date | null;
  subtotal: string;
  discount: string;
  discount_type: string | null;
  discount_value: string | null;
  service_charge: string;
  tax: string;
  tip_amount: string;
  order_total: string;
  item_id: string | null;
  item_name: string | null;
  quantity: number | null;
  unit_price: string | null;
  /** [{ name, price_delta }] in selection order — json rather than two parallel arrays so a name can never drift off its price. */
  modifiers: { name: string; price_delta: string | number }[] | null;
  item_status: string | null;
  note: string | null;
  void_reason: string | null;
}

interface ShiftOrderPaymentRow extends Record<string, unknown> {
  order_id: string;
  method: string;
  method_name: string | null;
  amount: string;
  reference: string | null;
  received_at: Date;
  received_by_name: string | null;
}

/**
 * The branch's order detail for one shift, newest order first. Returns null
 * when the branch has never had a shift — the caller renders an empty state
 * rather than an arbitrary date range, since without a shift there is no
 * "until the next shift" window to report on — and also when `shiftId` names
 * a shift outside the branch's recent list, so a stale or foreign id can
 * never leak another branch's orders.
 */
export async function getShiftOrdersReport(
  locationId: string,
  shiftId?: string,
): Promise<ShiftOrdersReport | null> {
  const shifts = await listRecentShiftOptions(locationId);

  const index = shiftId ? shifts.findIndex((option) => option.id === shiftId) : 0;
  const shift = index === -1 ? undefined : shifts[index];
  if (!shift) return null;

  const window = [locationId, shift.startedAt, shift.endedAt];

  // Two reads rather than one: an order can carry more than one payment row —
  // a refund, or the re-settlement a closed-order amendment writes — so
  // joining payments beside the items would multiply every line by every
  // payment. They are stitched back together by groupShiftOrders.
  const [{ rows }, { rows: paymentRows }] = await Promise.all([
    query<ShiftOrderItemRow>(
      `SELECT o.id AS order_id, o.order_number, o.type, o.status, dt.name AS table_name,
              o.guest_count, c.name AS customer_name,
              o.opened_at, o.closed_at, ou.full_name AS opened_by_name, cu.full_name AS closed_by_name,
              o.note AS order_note, o.voided_reason, o.amended_at,
              o.subtotal, o.discount, o.discount_type, o.discount_value,
              o.service_charge, o.tax, o.tip_amount, o.total AS order_total,
              oi.id AS item_id, oi.name_snapshot AS item_name, oi.quantity, oi.unit_price,
              oi.status AS item_status, oi.note, oi.void_reason,
              m.modifiers
         FROM orders o
         LEFT JOIN dining_tables dt ON dt.id = o.table_id
         LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN users ou ON ou.id = o.opened_by
         LEFT JOIN users cu ON cu.id = o.closed_by
         LEFT JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN LATERAL (
           SELECT json_agg(
                    json_build_object('name', oim.name_snapshot, 'price_delta', oim.price_delta)
                    ORDER BY oim.name_snapshot
                  ) AS modifiers
             FROM order_item_modifiers oim
            WHERE oim.order_item_id = oi.id
         ) m ON true
        WHERE o.location_id = $1
          AND o.opened_at >= $2
          AND o.opened_at <= coalesce($3::timestamptz, now())
        ORDER BY o.opened_at DESC, o.id DESC, oi.created_at`,
      window,
    ),
    query<ShiftOrderPaymentRow>(
      `SELECT p.order_id, p.method, pm.name AS method_name, p.amount, p.reference, p.received_at,
              u.full_name AS received_by_name
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         LEFT JOIN users u ON u.id = p.received_by
         LEFT JOIN payment_methods pm ON pm.id = p.payment_method_id
        WHERE o.location_id = $1
          AND o.opened_at >= $2
          AND o.opened_at <= coalesce($3::timestamptz, now())
        ORDER BY p.received_at`,
      window,
    ),
  ]);

  const inputs: ShiftOrderItemInput[] = rows.map((row) => ({
    orderId: row.order_id,
    orderNumber: Number(row.order_number),
    type: row.type as ShiftOrderItemInput["type"],
    status: row.status,
    tableName: row.table_name,
    guestCount: row.guest_count === null ? null : Number(row.guest_count),
    customerName: row.customer_name,
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    openedByName: row.opened_by_name,
    closedByName: row.closed_by_name,
    orderNote: row.order_note,
    voidedReason: row.voided_reason,
    amendedAt: row.amended_at ? row.amended_at.toISOString() : null,
    subtotal: Number(row.subtotal),
    discount: Number(row.discount),
    discountType: (row.discount_type as ShiftOrderItemInput["discountType"]) ?? null,
    discountValue: row.discount_value === null ? null : Number(row.discount_value),
    serviceCharge: Number(row.service_charge),
    tax: Number(row.tax),
    tipAmount: Number(row.tip_amount ?? 0),
    orderTotal: Number(row.order_total),
    itemId: row.item_id,
    itemName: row.item_name,
    quantity: Number(row.quantity ?? 0),
    unitPrice: Number(row.unit_price ?? 0),
    modifiers: (row.modifiers ?? []).map(
      (modifier): ShiftOrderModifier => ({
        name: modifier.name,
        priceDelta: Number(modifier.price_delta),
      }),
    ),
    itemStatus: row.item_status,
    note: row.note,
    voidReason: row.void_reason,
  }));

  const payments: ShiftOrderPaymentInput[] = paymentRows.map((row) => ({
    orderId: row.order_id,
    method: row.method,
    methodName: row.method_name,
    amount: Number(row.amount),
    reference: row.reference,
    receivedAt: row.received_at.toISOString(),
    receivedByName: row.received_by_name,
  }));

  return {
    shift,
    shifts,
    orders: groupShiftOrders(inputs, payments),
  };
}
