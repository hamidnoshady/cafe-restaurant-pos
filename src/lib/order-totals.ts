/**
 * Server-side helper: recompute an order's subtotal/discount/tax/total from
 * its current (non-voided) order_items + their modifiers, and persist it.
 * Used whenever items or the discount change after the order was created.
 *
 * Note: order_items.unit_price is a snapshot taken at order creation and is
 * never touched by later menu price changes. Category tax_rate is NOT
 * snapshotted (mirrors the rest of the app, which keeps tax_rate live on
 * the category), so it's read fresh here.
 */
import type { PoolClient } from "pg";
import { computeOrderTotals, type CartLine, type DiscountInput, type OrderTotals } from "./orders";

export async function recomputeOrderTotals(
  client: PoolClient,
  orderId: string,
  discount: DiscountInput,
): Promise<OrderTotals> {
  const { rows } = await client.query<{
    unit_price: string;
    quantity: number;
    tax_rate: string;
    mod_deltas: string[] | null;
  }>(
    `SELECT oi.unit_price, oi.quantity, COALESCE(mc.tax_rate, 0) AS tax_rate,
            ARRAY(SELECT price_delta FROM order_item_modifiers oim
                   WHERE oim.order_item_id = oi.id) AS mod_deltas
       FROM order_items oi
       LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
       LEFT JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE oi.order_id = $1 AND oi.status != 'voided'`,
    [orderId],
  );

  const lines: CartLine[] = rows.map((r) => ({
    unitPrice: Number(r.unit_price),
    quantity: r.quantity,
    modifierDeltas: (r.mod_deltas ?? []).map(Number),
    taxRatePercent: Number(r.tax_rate),
  }));
  const totals = computeOrderTotals(lines, discount);

  await client.query(
    `UPDATE orders SET subtotal = $2, discount = $3, discount_type = $4, discount_value = $5,
            tax = $6, total = $7 WHERE id = $1`,
    [
      orderId,
      totals.subtotal,
      totals.discount,
      discount.type,
      discount.type ? discount.value : null,
      totals.tax,
      totals.total,
    ],
  );
  return totals;
}
