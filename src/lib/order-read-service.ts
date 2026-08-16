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

export interface ClosedOrdersOptions {
  /** Upper bound on closed_at — the end of a finished shift. Omit for "up to now". */
  until?: Date | string | null;
  /** Safety net for an unusually busy window, not a paging cursor. */
  limit?: number;
}

/**
 * The branch's orders that were *closed* — completed or voided — inside the
 * window starting at `since`, newest close first. Paired with
 * `listOrders(..., { status: "open" })` by the orders screen: the open queue
 * plus what has already been settled, which is otherwise invisible the moment
 * it is paid.
 *
 * The window is the caller's to choose — the current business day, or one
 * shift's own `[started_at, ended_at]` when someone with the privilege to
 * review shifts picks one.
 *
 * Voided orders are kept rather than filtered out: "what happened to order #12"
 * is exactly the question this list exists to answer, and the caller renders
 * the status.
 */
export async function listOrdersClosedSince(
  locationId: string,
  since: Date | string,
  options: ClosedOrdersOptions = {},
) {
  const { until = null, limit = 200 } = options;
  const { rows } = await query(
    ORDER_SUMMARY_SELECT +
      " WHERE o.location_id = $1 AND o.status IN ('completed', 'voided')" +
      " AND o.closed_at IS NOT NULL AND o.closed_at >= $2" +
      " AND ($3::timestamptz IS NULL OR o.closed_at <= $3::timestamptz)" +
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
