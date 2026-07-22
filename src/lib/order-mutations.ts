/**
 * Shared order-creation / add-items transactions (DB-touching; not unit-
 * tested directly, per repo convention — order-totals.ts's note applies
 * here too). Extracted out of the API route handlers so the same logic
 * backs both the synchronous POST /api/orders[/*] routes (Phase 2/4) and
 * the offline-queue replay path (sync-events.ts, Phase 5) — an order
 * created while offline must behave identically to one created online.
 */
import { getPool, query } from "./db";
import { createDeliveryForOrder } from "./delivery-service";
import { resolveCartItems, validateItemShape, type CartItemInput } from "./order-cart";
import { computeOrderTotals, type DiscountInput, type OrderTotals } from "./orders";
import { recomputeOrderTotals } from "./order-totals";
import { ensureSessionForTable } from "./table-session-service";

export type MutationResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export type OrderType = "dine_in" | "takeaway" | "delivery";

/** Delivery details supplied at intake for a `type: 'delivery'` order. */
export interface DeliveryInput {
  address: string;
  phone?: string | null;
  /** flat delivery fee, Rial — rides on the order's service_charge so it flows through payment + ledger. */
  fee?: number | null;
  /** optional courier assigned right at intake; otherwise the delivery starts pending on the dispatch board. */
  courierId?: string | null;
  note?: string | null;
}

export interface CreateOrderInput {
  locationId: string;
  type: OrderType;
  tableId?: string | null;
  guestCount?: number | null;
  note?: string | null;
  discount: DiscountInput;
  items: CartItemInput[];
  openedBy: string | null;
  /** required when type === 'delivery', ignored otherwise. */
  delivery?: DeliveryInput | null;
}

export interface CreateOrderOutput {
  id: string;
  orderNumber: number;
  type: OrderType;
  totals: OrderTotals;
}

/** Same validation + transaction as POST /api/orders. */
export async function createOrder(input: CreateOrderInput): Promise<MutationResult<CreateOrderOutput>> {
  const shapeError = validateItemShape(input.items);
  if (shapeError) return { ok: false, error: shapeError, status: 400 };

  let tableId: string | null = null;
  if (input.type === "dine_in") {
    tableId = input.tableId ?? null;
    if (!tableId) return { ok: false, error: "table_required", status: 400 };
    const { rows: table } = await query<{ id: string; status: string }>(
      "SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active",
      [tableId, input.locationId],
    );
    if (table.length === 0) return { ok: false, error: "table_not_found", status: 404 };
    if (table[0].status === "cleaning" || table[0].status === "out_of_service") {
      return { ok: false, error: "table_unavailable", status: 409 };
    }
  }

  // Delivery orders carry an address (required) and a flat fee. The fee is
  // set as the order's service_charge below so it's inside orders.total and
  // flows through payment + COGS/ledger with no delivery-specific handling.
  let deliveryAddress: string | null = null;
  let deliveryFee = 0;
  let deliveryCourierId: string | null = null;
  if (input.type === "delivery") {
    deliveryAddress = input.delivery?.address?.trim() || null;
    if (!deliveryAddress) return { ok: false, error: "address_required", status: 400 };
    const fee = Number(input.delivery?.fee ?? 0);
    if (!Number.isFinite(fee) || fee < 0) return { ok: false, error: "invalid_delivery_fee", status: 400 };
    deliveryFee = Math.round(fee);
    deliveryCourierId = input.delivery?.courierId ?? null;
    if (deliveryCourierId) {
      const { rows: courier } = await query<{ id: string }>(
        "SELECT id FROM couriers WHERE id = $1 AND location_id = $2 AND is_active",
        [deliveryCourierId, input.locationId],
      );
      if (courier.length === 0) return { ok: false, error: "courier_not_found", status: 404 };
    }
  }

  const resolved = await resolveCartItems(input.locationId, input.items);
  if (!resolved.ok) return { ok: false, error: resolved.error, status: resolved.status };
  const { cartLines, preparedItems } = resolved;
  const totals = computeOrderTotals(cartLines, input.discount, deliveryFee);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: counter } = await client.query<{ next_number: string }>(
      `INSERT INTO order_number_counters (location_id, next_number) VALUES ($1, 2)
       ON CONFLICT (location_id) DO UPDATE SET next_number = order_number_counters.next_number + 1
       RETURNING next_number - 1 AS next_number`,
      [input.locationId],
    );
    const orderNumber = Number(counter[0].next_number);

    let tableSessionId: string | null = null;
    if (input.type === "dine_in" && tableId) {
      tableSessionId = await ensureSessionForTable(client, input.locationId, tableId, input.openedBy, input.guestCount ?? null);
    }

    const discountType = input.discount.type;
    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, table_id, table_session_id, guest_count,
              subtotal, discount, discount_type, discount_value, service_charge, tax, total, note, opened_by)
       VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        input.locationId,
        orderNumber,
        input.type,
        tableId,
        tableSessionId,
        input.guestCount ?? null,
        totals.subtotal,
        totals.discount,
        discountType,
        discountType ? input.discount.value : null,
        deliveryFee,
        totals.tax,
        totals.total,
        input.note?.trim() || null,
        input.openedBy,
      ],
    );
    const orderId = orderRows[0].id;

    if (input.type === "delivery" && deliveryAddress) {
      await createDeliveryForOrder(client, {
        locationId: input.locationId,
        orderId,
        address: deliveryAddress,
        phone: input.delivery?.phone?.trim() || null,
        fee: deliveryFee,
        courierId: deliveryCourierId,
        note: input.delivery?.note?.trim() || null,
      });
    }

    for (const item of preparedItems) {
      // Submitting the order *is* "send to kitchen": items land as 'sent'
      // straight away so they appear on the KDS within ~1s (Phase 4).
      const { rows: itemRows } = await client.query<{ id: string }>(
        `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, note, status, sent_to_kitchen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent', now()) RETURNING id`,
        [input.locationId, orderId, item.menuItemId, item.name, item.unitPrice, item.quantity, item.note],
      );
      const orderItemId = itemRows[0].id;
      for (const mod of item.modifiers) {
        await client.query(
          `INSERT INTO order_item_modifiers (order_item_id, modifier_id, name_snapshot, price_delta)
           VALUES ($1, $2, $3, $4)`,
          [orderItemId, mod.id, mod.name, mod.priceDelta],
        );
      }
    }

    await client.query("COMMIT");
    return { ok: true, data: { id: orderId, orderNumber, type: input.type, totals } };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface AddItemsInput {
  locationId: string;
  orderId: string;
  items: CartItemInput[];
}

/** Same validation + transaction as POST /api/orders/[id]/items. */
export async function addItemsToOrder(input: AddItemsInput): Promise<MutationResult<{ totals: OrderTotals }>> {
  const { rows: orderRows } = await query<{
    id: string;
    status: string;
    discount_type: "percent" | "amount" | null;
    discount_value: string | null;
  }>("SELECT id, status, discount_type, discount_value FROM orders WHERE id = $1 AND location_id = $2", [
    input.orderId,
    input.locationId,
  ]);
  const order = orderRows[0];
  if (!order) return { ok: false, error: "order_not_found", status: 404 };
  if (order.status !== "open") return { ok: false, error: "order_not_open", status: 409 };

  const shapeError = validateItemShape(input.items);
  if (shapeError) return { ok: false, error: shapeError, status: 400 };

  const resolved = await resolveCartItems(input.locationId, input.items);
  if (!resolved.ok) return { ok: false, error: resolved.error, status: resolved.status };
  const { preparedItems } = resolved;

  const discount: DiscountInput = order.discount_type
    ? { type: order.discount_type, value: Number(order.discount_value ?? 0) }
    : { type: null };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const item of preparedItems) {
      const { rows: itemRows } = await client.query<{ id: string }>(
        `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, note, status, sent_to_kitchen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent', now()) RETURNING id`,
        [input.locationId, input.orderId, item.menuItemId, item.name, item.unitPrice, item.quantity, item.note],
      );
      const orderItemId = itemRows[0].id;
      for (const mod of item.modifiers) {
        await client.query(
          `INSERT INTO order_item_modifiers (order_item_id, modifier_id, name_snapshot, price_delta)
           VALUES ($1, $2, $3, $4)`,
          [orderItemId, mod.id, mod.name, mod.priceDelta],
        );
      }
    }
    const totals = await recomputeOrderTotals(client, input.orderId, discount);
    await client.query("COMMIT");
    return { ok: true, data: { totals } };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
