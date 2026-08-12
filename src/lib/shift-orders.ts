/**
 * Item-by-item order detail for the current shift — the framework-free half.
 *
 * The reporting views (Phase 8, migration 0008) all aggregate: the finest
 * grain any of them expose is "one menu item per business day"
 * (v_menu_item_performance). Reviewing a shift order by order needs the
 * transactional rows themselves, so this pairs with shift-orders-service.ts
 * the same way reports.ts pairs with reports-service.ts — the grouping rule
 * lives here and is unit tested; the query lives there.
 *
 * A line's amount reuses computeLineSubtotal (orders.ts) rather than
 * recomputing "(unit price + modifiers) × quantity" a second time, so this
 * report can never disagree with what the cashier was charged. It is a
 * *pre-discount* line amount: an order's discount is applied at the order
 * level, and only the order total reflects it.
 */
import { computeLineSubtotal } from "./orders";
import type { Rial } from "./money";

export type OrderKind = "dine_in" | "takeaway" | "delivery";

/** One order_items row joined onto its order, with its modifier deltas collapsed into an array. */
export interface ShiftOrderItemInput {
  orderId: string;
  orderNumber: number;
  type: OrderKind;
  status: string;
  tableName: string | null;
  openedAt: string;
  orderTotal: Rial;
  /** null when the order has no lines yet — an order opened but nothing rung in. */
  itemId: string | null;
  itemName: string | null;
  quantity: number;
  unitPrice: Rial;
  modifierDeltas: Rial[];
  itemStatus: string | null;
  note: string | null;
}

export interface ShiftOrderLine {
  itemId: string;
  name: string;
  quantity: number;
  /** (unitPrice + modifier deltas) × quantity, Rial — before the order-level discount. */
  amount: Rial;
  note: string | null;
  voided: boolean;
}

export interface ShiftOrder {
  id: string;
  orderNumber: number;
  type: OrderKind;
  status: string;
  tableName: string | null;
  openedAt: string;
  /** The order's own recorded total (post-discount, with tax/service charge) — not the sum of `lines`. */
  total: Rial;
  lines: ShiftOrderLine[];
  /** Units across non-voided lines. */
  itemCount: number;
}

/**
 * Collapses the flat join into one entry per order, keeping the input's row
 * order (the service orders newest first) so the caller decides sorting.
 * Voided lines are kept and flagged rather than dropped — a voided item is
 * exactly the kind of thing someone reviewing a shift is looking for — but
 * they don't count toward `itemCount`.
 */
export function groupShiftOrders(rows: ShiftOrderItemInput[]): ShiftOrder[] {
  const byId = new Map<string, ShiftOrder>();
  for (const row of rows) {
    let order = byId.get(row.orderId);
    if (!order) {
      order = {
        id: row.orderId,
        orderNumber: row.orderNumber,
        type: row.type,
        status: row.status,
        tableName: row.tableName,
        openedAt: row.openedAt,
        total: row.orderTotal,
        lines: [],
        itemCount: 0,
      };
      byId.set(row.orderId, order);
    }
    if (!row.itemId) continue;
    const voided = row.itemStatus === "voided";
    order.lines.push({
      itemId: row.itemId,
      name: row.itemName ?? "",
      quantity: row.quantity,
      amount: computeLineSubtotal({
        unitPrice: row.unitPrice,
        quantity: row.quantity,
        modifierDeltas: row.modifierDeltas,
      }),
      note: row.note,
      voided,
    });
    if (!voided) order.itemCount += row.quantity;
  }
  return [...byId.values()];
}
