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
    "SELECT o.id, o.order_number, o.type, o.status, o.table_id, dt.name AS table_name, " +
      "o.guest_count, o.subtotal, o.discount, o.discount_type, o.discount_value, " +
      "o.service_charge, o.tax, o.total, o.note, o.opened_at, o.closed_at, o.voided_reason " +
      "FROM orders o LEFT JOIN dining_tables dt ON dt.id = o.table_id " +
      "WHERE " + where.join(" AND ") + " ORDER BY o.opened_at DESC, o.id DESC" + limitClause,
    params,
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
