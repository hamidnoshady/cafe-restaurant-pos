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
 * The branch's orders that were *closed* — completed or voided — at or after
 * `since`, newest close first. Paired with `listOrders(..., { status: "open" })`
 * by the orders screen, which passes the start of the branch's running shift so
 * a cashier can look back over what they already closed this shift; the list
 * empties on its own once the shift ends and there is no window to ask for.
 *
 * Voided orders are kept rather than filtered out: "what happened to order #12"
 * is exactly the question this list exists to answer, and the caller renders the
 * status. `limit` is a safety net for a branch that closes an unusual number of
 * orders in one shift, not a paging cursor.
 */
export async function listOrdersClosedSince(
  locationId: string,
  since: Date | string,
  limit = 200,
) {
  const { rows } = await query(
    ORDER_SUMMARY_SELECT +
      " WHERE o.location_id = $1 AND o.status IN ('completed', 'voided')" +
      " AND o.closed_at IS NOT NULL AND o.closed_at >= $2" +
      " ORDER BY o.closed_at DESC, o.id DESC LIMIT $3",
    [locationId, since, limit],
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
      "SELECT oim.id, oim.order_item_id, oim.name_snapshot, oim.price_delta FROM order_item_modifiers oim JOIN order_items oi ON oi.id = oim.order_item_id WHERE oi.order_id = $1",
      [id],
    ),
  ]);

  return { order, items, modifiers };
}
