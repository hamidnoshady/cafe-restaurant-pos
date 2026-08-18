import { query } from "./db";

const ORDER_STATUSES = ["open", "held", "completed", "voided"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export interface ListOrdersOptions {
  status?: OrderStatus;
  /** Undefined intentionally means no artificial dashboard limit. Public callers set their own bounded limit. */
  limit?: number;
}

/** The summary shape both order lists return, so the two can never disagree on columns. */
const ORDER_SUMMARY_SELECT =
  "SELECT o.id, o.order_number, o.type, o.status, o.table_id, dt.name AS table_name, " +
  "o.guest_count, o.subtotal, o.discount, o.discount_type, o.discount_value, " +
  "o.service_charge, o.tax, o.total, o.note, o.opened_at, o.closed_at, o.voided_reason " +
  "FROM orders o LEFT JOIN dining_tables dt ON dt.id = o.table_id";

/**
 * Reads order summaries from exactly one branch. Branch-level isolation is
 * application-enforced in this product, so every public-key read retains the
 * location predicate even though tenant RLS already enforces the business.
 */
export async function listOrders(locationId: string, options: ListOrdersOptions = {}) {
  const params: unknown[] = [locationId];
  const where = ["o.location_id = $1"];

  if (options.status) {
    params.push(options.status);
    where.push("o.status = $" + params.length);
  }

  let limitClause = "";
  if (options.limit !== undefined) {
    params.push(options.limit);
    limitClause = " LIMIT $" + params.length;
  }

  const { rows } = await query(
    ORDER_SUMMARY_SELECT +
      " WHERE " + where.join(" AND ") + " ORDER BY o.opened_at DESC, o.id DESC" + limitClause,
    params,
  );
  return rows;
}

/**
 * The predicate that decides **which shift or business day an order belongs
 * to**: the one whose window contains the order's `opened_at`. Shared verbatim
 * by `listSettledOrdersInWindow` here and by `getShiftOrdersReport`
 * (shift-orders-service.ts) so the orders screen and the shift report can never
 * disagree about whose order it is — the two used to answer that question with
 * different columns, and a bill carried across a cash-up was the case where
 * they contradicted each other.
 *
 * Bucketing on `opened_at` rather than `closed_at` is the load-bearing part. A
 * table opened at 23:30 and finally settled at 08:00 the next morning is one
 * sale, and it is the *night* shift's sale: that is the shift that seated the
 * guests, rang the items in, and is answerable for the bill. Keying on
 * `closed_at` instead credited it to whichever shift happened to take the last
 * payment, so a carried-over bill left the shift that opened it and inflated a
 * shift that had nothing to do with it.
 *
 * Both bounds are inclusive, and a null upper bound leaves the window open-ended
 * rather than clamping it to this instant: a running shift and the branch's live
 * window have no end yet, and clamping would quietly drop a row whose
 * `opened_at` is ahead of the server clock — a till with a skewed clock, or a
 * sale typed in for a moment that has not arrived — from the one screen a
 * cashier would use to notice. Written against `$2` (window start) and `$3`
 * (window end) so every caller binds the same parameter positions.
 */
export const ORDER_OPENED_IN_WINDOW =
  "o.opened_at >= $2 AND ($3::timestamptz IS NULL OR o.opened_at <= $3::timestamptz)";

export interface ClosedOrdersOptions {
  /**
   * End of the window — the end of a finished shift, or the end of the picked
   * business day. Omit for "up to now".
   */
  until?: Date | string | null;
  /** Safety net for an unusually busy window, not a paging cursor. */
  limit?: number;
}

/**
 * The branch's already-settled orders — completed or voided — that *belong* to
 * the window `[since, until]`, newest close first. Paired with
 * `listOrders(..., { status: "open" })` by the orders screen: the open queue
 * plus what has already been settled, which is otherwise invisible the moment
 * it is paid.
 *
 * The window is the caller's to choose — the branch's current business day, or
 * one shift's own `[started_at, ended_at]` when someone with the privilege to
 * review shifts picks one.
 *
 * "Belongs to" is `ORDER_OPENED_IN_WINDOW` above, not "was closed inside it",
 * and the difference is the whole point of this function's shape. Two
 * consequences are deliberate, and both are what the shift report has always
 * done:
 *
 *   - a bill opened inside the window is listed here **however late it was
 *     settled** — including after the shift ended or after the day was closed,
 *     which is exactly the carried-over table this rule exists for;
 *   - a bill opened *before* the window is never listed, even though the
 *     payment landed inside it. It stays with the shift that opened it, and is
 *     reached by picking that shift rather than by appearing twice.
 *
 * Voided orders are kept rather than filtered out: "what happened to order #12"
 * is exactly the question this list exists to answer, and the caller renders
 * the status.
 */
export async function listSettledOrdersInWindow(
  locationId: string,
  since: Date | string,
  options: ClosedOrdersOptions = {},
) {
  const { until = null, limit = 200 } = options;
  const { rows } = await query(
    ORDER_SUMMARY_SELECT +
      " WHERE o.location_id = $1 AND o.status IN ('completed', 'voided')" +
      " AND o.closed_at IS NOT NULL AND " + ORDER_OPENED_IN_WINDOW +
      " ORDER BY o.closed_at DESC, o.id DESC LIMIT $4",
    [locationId, since, until, limit],
  );
  return rows;
}

export interface OrderDetail {
  order: Record<string, unknown>;
  items: Record<string, unknown>[];
  modifiers: Record<string, unknown>[];
}

/** Fetches one order and its immutable line/modifier snapshots from one branch. */
export async function getOrderDetail(locationId: string, id: string): Promise<OrderDetail | null> {
  const { rows: orders } = await query<Record<string, unknown>>(
    "SELECT o.*, dt.name AS table_name FROM orders o LEFT JOIN dining_tables dt ON dt.id = o.table_id WHERE o.id = $1 AND o.location_id = $2",
    [id, locationId],
  );
  const order = orders[0];
  if (!order) return null;

  const [{ rows: items }, { rows: modifiers }] = await Promise.all([
    query(
      "SELECT id, menu_item_id, name_snapshot, unit_price, quantity, status, note, void_reason, created_at FROM order_items WHERE order_id = $1 ORDER BY created_at",
      [id],
    ),
    query(
      // modifier_id rides along so an open order's line can be re-opened in the
      // add-on picker with its current selection already ticked.
      "SELECT oim.id, oim.order_item_id, oim.modifier_id, oim.name_snapshot, oim.price_delta FROM order_item_modifiers oim JOIN order_items oi ON oi.id = oim.order_item_id WHERE oi.order_id = $1",
      [id],
    ),
  ]);

  return { order, items, modifiers };
}
