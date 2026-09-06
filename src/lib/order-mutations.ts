/**
 * Shared order-creation / add-items transactions (DB-touching; not unit-
 * tested directly, per repo convention — order-totals.ts's note applies
 * here too). Extracted out of the API route handlers so the same logic
 * backs both the synchronous POST /api/orders[/*] routes (Phase 2/4) and
 * the offline-queue replay path (sync-events.ts, Phase 5) — an order
 * created while offline must behave identically to one created online.
 */
import { getPool, query } from "./db";
import { invalidateTodayForBusiness } from "./ai-answer-cache";
import { createDeliveryForOrder } from "./delivery-service";
import {
  resolveCartItems,
  resolveLineModifiers,
  validateItemShape,
  type CartItemInput,
} from "./order-cart";
import {
  computeOrderTotals,
  type DiscountInput,
  type OrderTotals,
} from "./orders";
import { recomputeOrderTotals } from "./order-totals";
import { lockOpenOrder } from "./order-lock";
import { ensureSessionForTable } from "./table-session-service";
import {
  businessIdForLocation,
  monthlyOrderCount,
  planLimitsFor,
} from "./plan-limits";
import type { PoolClient } from "pg";

/**
 * Capture the recipe plus modifier deltas as an immutable per-unit snapshot.
 *
 * Exported for order-amendment-service.ts: a line added to an already-closed
 * order has to be snapshotted the same way an intake line is, or the replayed
 * consumption would fall back to today's recipe for it.
 */
export async function captureInventorySnapshot(
  client: PoolClient,
  orderItemId: string,
  menuItemId: string,
  modifierIds: string[],
): Promise<void> {
  const { rows } = await client.query<{
    inventory_item_id: string;
    required_quantity: string;
  }>(
    `WITH requirements AS (
       SELECT inventory_item_id, quantity::numeric AS qty
       FROM menu_item_ingredients WHERE menu_item_id=$1
       UNION ALL
       SELECT inventory_item_id, quantity_delta::numeric
       FROM modifier_ingredients WHERE modifier_id=ANY($2::uuid[])
     )
     SELECT inventory_item_id, sum(qty)::text required_quantity
     FROM requirements GROUP BY inventory_item_id`,
    [menuItemId, modifierIds],
  );
  for (const row of rows) {
    if (Number(row.required_quantity) < 0)
      throw new Error("negative_ingredient_requirement");
    if (row.required_quantity === "0" || Number(row.required_quantity) === 0)
      continue;
    await client.query(
      `INSERT INTO order_item_inventory_snapshots
       (order_item_id,inventory_item_id,required_quantity,source_menu_item_id,source_modifier_ids)
       VALUES($1,$2,$3,$4,$5)`,
      [
        orderItemId,
        row.inventory_item_id,
        row.required_quantity,
        menuItemId,
        modifierIds,
      ],
    );
  }
}

export type MutationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };

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
  /**
   * Optional customer the sale is attributed to, picked at the till. Customers
   * are business-wide (see parties-service.ts), so it is validated against
   * the location's business rather than the location itself.
   */
  customerId?: string | null;
  guestCount?: number | null;
  note?: string | null;
  discount: DiscountInput;
  items: CartItemInput[];
  openedBy: string | null;
  /** required when type === 'delivery', ignored otherwise. */
  delivery?: DeliveryInput | null;
  /**
   * Client-generated id for this submission attempt (a `crypto.randomUUID()`
   * minted once per attempt and reused across retries of it — the same
   * contract as sync-events.ts's `clientEventId`). A repeat with the same id
   * for the same location returns the order already created rather than
   * inserting a second one, so a lost response or a proxy retry on the
   * synchronous POST /api/orders path can't double-order.
   */
  clientRequestId?: string | null;
}

export interface CreateOrderOutput {
  id: string;
  orderNumber: number;
  type: OrderType;
  totals: OrderTotals;
}

interface OrderRow extends Record<string, unknown> {
  id: string;
  order_number: string;
  type: OrderType;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
}

interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * Looks up a prior order by its client-generated submission id. Used both
 * before the INSERT (the common case: the earlier attempt already committed)
 * and after a unique-violation on it (two near-simultaneous attempts raced
 * the check-then-insert above; the loser reads back what the winner just
 * committed instead of surfacing a 500 for what was, from the till's point
 * of view, a single submission).
 */
async function findOrderByClientRequestId(
  queryable: Queryable,
  locationId: string,
  clientRequestId: string,
): Promise<CreateOrderOutput | null> {
  const { rows } = await queryable.query<OrderRow>(
    `SELECT id, order_number, type, subtotal, discount, tax, total
       FROM orders WHERE location_id = $1 AND client_request_id = $2`,
    [locationId, clientRequestId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    orderNumber: Number(row.order_number),
    type: row.type,
    totals: {
      subtotal: Number(row.subtotal),
      discount: Number(row.discount),
      tax: Number(row.tax),
      total: Number(row.total),
      lines: [],
    },
  };
}

/** Same validation + transaction as POST /api/orders. */
export async function createOrder(
  input: CreateOrderInput,
): Promise<MutationResult<CreateOrderOutput>> {
  const shapeError = validateItemShape(input.items);
  if (shapeError) return { ok: false, error: shapeError, status: 400 };

  const businessId = await businessIdForLocation(input.locationId);
  if (businessId) {
    const limits = await planLimitsFor(businessId);
    if (
      limits.monthlyOrderLimit !== null &&
      (await monthlyOrderCount(businessId)) >= limits.monthlyOrderLimit
    ) {
      return { ok: false, error: "monthly_order_limit_exceeded", status: 403 };
    }
  }

  const customerId = input.customerId?.trim() || null;
  if (customerId) {
    const params: unknown[] = [customerId];
    if (businessId) params.push(businessId);
    const { rows: customer } = await query<{ id: string }>(
      `SELECT id FROM parties WHERE id = $1` + (businessId ? ` AND business_id = $2` : ``),
      params,
    );
    if (customer.length === 0)
      return { ok: false, error: "customer_not_found", status: 404 };
  }

  // The till asks for the table before it places a dine-in order, but a table
  // is still optional here: a backdated sale or a queue-first workflow assigns
  // one afterwards from the order-progress screen. Takeaway/delivery remain
  // table-less as before. An already-seated table is accepted — a second order
  // on it is a party splitting its bill, and `ensureSessionForTable` below
  // joins the table's open session rather than opening a second one.
  const tableId = input.type === "dine_in" ? input.tableId ?? null : null;
  if (tableId) {
    const { rows: table } = await query<{ id: string; status: string }>(
      "SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active",
      [tableId, input.locationId],
    );
    if (table.length === 0)
      return { ok: false, error: "table_not_found", status: 404 };
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
    if (!deliveryAddress)
      return { ok: false, error: "address_required", status: 400 };
    const fee = Number(input.delivery?.fee ?? 0);
    if (!Number.isFinite(fee) || fee < 0)
      return { ok: false, error: "invalid_delivery_fee", status: 400 };
    deliveryFee = Math.round(fee);
    deliveryCourierId = input.delivery?.courierId ?? null;
    if (deliveryCourierId) {
      const { rows: courier } = await query<{ id: string }>(
        "SELECT id FROM couriers WHERE id = $1 AND location_id = $2 AND is_active",
        [deliveryCourierId, input.locationId],
      );
      if (courier.length === 0)
        return { ok: false, error: "courier_not_found", status: 404 };
    }
  }

  const resolved = await resolveCartItems(input.locationId, input.items);
  if (!resolved.ok)
    return { ok: false, error: resolved.error, status: resolved.status };
  const { cartLines, preparedItems } = resolved;
  const totals = computeOrderTotals(cartLines, input.discount, deliveryFee);

  const clientRequestId = input.clientRequestId?.trim() || null;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    if (clientRequestId) {
      // A replay of a submission this location already accepted — a lost
      // response, a proxy retry, or two near-simultaneous taps — returns the
      // order already created instead of burning an order_number and
      // inserting a second one. Checked before the INSERT, inside this same
      // transaction, the same shape as sync-events.ts's client_event_id replay.
      const existing = await findOrderByClientRequestId(
        client,
        input.locationId,
        clientRequestId,
      );
      if (existing) {
        await client.query("COMMIT");
        return { ok: true, data: existing };
      }
    }

    const { rows: counter } = await client.query<{ next_number: string }>(
      `INSERT INTO order_number_counters (location_id, next_number) VALUES ($1, 2)
       ON CONFLICT (location_id) DO UPDATE SET next_number = order_number_counters.next_number + 1
       RETURNING next_number - 1 AS next_number`,
      [input.locationId],
    );
    const orderNumber = Number(counter[0].next_number);

    let tableSessionId: string | null = null;
    if (input.type === "dine_in" && tableId) {
      tableSessionId = await ensureSessionForTable(
        client,
        input.locationId,
        tableId,
        input.openedBy,
        input.guestCount ?? null,
      );
    }

    const discountType = input.discount.type;
    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, table_id, table_session_id, customer_id, guest_count,
              subtotal, discount, discount_type, discount_value, service_charge, tax, total, note, opened_by, client_request_id)
       VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id`,
      [
        input.locationId,
        orderNumber,
        input.type,
        tableId,
        tableSessionId,
        customerId,
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
        clientRequestId,
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
        [
          input.locationId,
          orderId,
          item.menuItemId,
          item.name,
          item.unitPrice,
          item.quantity,
          item.note,
        ],
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

    await client.query("COMMIT");
    // Phase 36 Wave 7 — a new order changes today's window (and, through
    // `*..*` signatures, any unbounded read), so cached answers covering the
    // current trading day are dropped. After COMMIT, never throws: a cached
    // answer is not worth a failed sale.
    if (businessId) {
      await invalidateTodayForBusiness(businessId).catch(() => {});
    }
    return {
      ok: true,
      data: { id: orderId, orderNumber, type: input.type, totals },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    if (
      clientRequestId &&
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "23505" &&
      (err as { constraint?: string }).constraint ===
        "uq_orders_location_client_request_id"
    ) {
      // Lost the race against a near-simultaneous duplicate submission: the
      // other request's INSERT committed between our pre-check and our own
      // INSERT. Read back what it created rather than surfacing a 500 for
      // what the till only ever sent once.
      const existing = await findOrderByClientRequestId(
        { query },
        input.locationId,
        clientRequestId,
      );
      if (existing) return { ok: true, data: existing };
    }
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
export async function addItemsToOrder(
  input: AddItemsInput,
): Promise<MutationResult<{ totals: OrderTotals }>> {
  const shapeError = validateItemShape(input.items);
  if (shapeError) return { ok: false, error: shapeError, status: 400 };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await lockOpenOrder(client, input.locationId, input.orderId);
    if (!locked.ok) {
      await client.query("ROLLBACK");
      return locked;
    }
    const resolved = await resolveCartItems(
      input.locationId,
      input.items,
      client,
    );
    if (!resolved.ok) {
      await client.query("ROLLBACK");
      return { ok: false, error: resolved.error, status: resolved.status };
    }
    const { preparedItems } = resolved;
    const discount: DiscountInput = locked.order.discount_type
      ? {
          type: locked.order.discount_type,
          value: Number(locked.order.discount_value ?? 0),
        }
      : { type: null };

    for (const item of preparedItems) {
      const { rows: itemRows } = await client.query<{ id: string }>(
        `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, note, status, sent_to_kitchen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent', now()) RETURNING id`,
        [
          input.locationId,
          input.orderId,
          item.menuItemId,
          item.name,
          item.unitPrice,
          item.quantity,
          item.note,
        ],
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

const MAX_LINE_QTY = 50;

/**
 * Why the old line is voided rather than edited, in the audit trail itself.
 * Shown to staff on the order, so it is Persian like every other void reason.
 */
export const MODIFIERS_SUPERSEDED_REASON = "جایگزین شد — ویرایش افزودنی‌ها";

export interface UpdateOrderItemInput {
  locationId: string;
  orderId: string;
  orderItemId: string;
  /** Every field is optional; each present one is applied, all inside one transaction. */
  quantity?: number;
  /** `null` clears the line's note. */
  note?: string | null;
  /** The line's add-ons after the edit — a full replacement, not a delta. */
  modifierIds?: string[];
  /** Voiding wins over every other field, since a voided line has nothing left to edit. */
  void?: { reason?: string | null };
}

/**
 * Same validation + transaction as PATCH /api/orders/[id]/items/[itemId]:
 * re-quantify, re-note, re-pick add-ons, or void one line of an order that is
 * still open.
 *
 * Re-picking add-ons is the reason this outgrew the route handler, and it is
 * done by *superseding* the line — voiding it and writing a replacement in
 * the same transaction — rather than by editing it in place. That is not a
 * detail of convenience: what a line consumes is captured once, per line, in
 * `order_item_inventory_snapshots`, and those rows are immutable by database
 * trigger ("create an explicit correction", migration 0013) precisely so the
 * ingredients behind a sale cannot be silently rewritten after the kitchen
 * has been told about them. Deduction at payment then skips voided lines
 * (inventory-service.ts), so the superseded line costs nothing and the
 * replacement carries a fresh, correct snapshot.
 *
 * The replacement keeps the quoted `unit_price` of the line it replaces — the
 * guest was quoted that price and only the add-ons changed — and goes to the
 * kitchen as a new 'sent' line, which is exactly right: the pass has to hear
 * that the bandari now comes with bread.
 */
export async function updateOrderItem(input: UpdateOrderItemInput): Promise<
  MutationResult<{
    totals: OrderTotals;
    voided: boolean;
    /** Set when add-ons were re-picked: the id of the line that replaced the edited one. */
    replacementItemId: string | null;
  }>
> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await lockOpenOrder(client, input.locationId, input.orderId);
    if (!locked.ok) {
      await client.query("ROLLBACK");
      return locked;
    }
    const { rows: itemRows } = await client.query<{
      id: string;
      status: string;
      menu_item_id: string | null;
      name_snapshot: string;
      unit_price: string;
      quantity: number;
      note: string | null;
    }>(
      `SELECT id, status, menu_item_id, name_snapshot, unit_price, quantity, note
         FROM order_items WHERE id = $1 AND order_id = $2`,
      [input.orderItemId, input.orderId],
    );
    const item = itemRows[0];
    if (!item) {
      await client.query("ROLLBACK");
      return { ok: false, error: "item_not_found", status: 404 };
    }
    if (item.status === "voided") {
      await client.query("ROLLBACK");
      return { ok: false, error: "item_already_voided", status: 409 };
    }

    const discount: DiscountInput = locked.order.discount_type
      ? {
          type: locked.order.discount_type,
          value: Number(locked.order.discount_value ?? 0),
        }
      : { type: null };

    let quantity = item.quantity;
    if (input.quantity !== undefined) {
      quantity = Number(input.quantity);
      if (
        !Number.isInteger(quantity) ||
        quantity <= 0 ||
        quantity > MAX_LINE_QTY
      ) {
        await client.query("ROLLBACK");
        return { ok: false, error: "invalid_item", status: 400 };
      }
    }
    const note =
      input.note !== undefined ? input.note?.trim() || null : item.note;

    let replacementItemId: string | null = null;

    if (input.void) {
      await client.query(
        "UPDATE order_items SET status = 'voided', void_reason = $2 WHERE id = $1",
        [input.orderItemId, input.void.reason?.trim() || null],
      );
    } else if (input.modifierIds !== undefined) {
      // A line whose menu item has since been deleted has nothing to validate
      // a new selection against, so its add-ons stay as sold.
      if (!item.menu_item_id) {
        await client.query("ROLLBACK");
        return { ok: false, error: "item_not_found", status: 404 };
      }
      const selection = await resolveLineModifiers(
        input.locationId,
        item.menu_item_id,
        input.modifierIds,
        client,
      );
      if (!selection.ok) {
        await client.query("ROLLBACK");
        return selection;
      }

      await client.query(
        "UPDATE order_items SET status = 'voided', void_reason = $2 WHERE id = $1",
        [input.orderItemId, MODIFIERS_SUPERSEDED_REASON],
      );
      const { rows: replacement } = await client.query<{ id: string }>(
        `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, note, status, sent_to_kitchen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent', now()) RETURNING id`,
        [
          input.locationId,
          input.orderId,
          item.menu_item_id,
          item.name_snapshot,
          item.unit_price,
          quantity,
          note,
        ],
      );
      replacementItemId = replacement[0].id;

      if (selection.modifiers.length > 0) {
        await client.query(
          `INSERT INTO order_item_modifiers (order_item_id, modifier_id, name_snapshot, price_delta)
           SELECT $1, * FROM UNNEST($2::uuid[], $3::text[], $4::bigint[])`,
          [
            replacementItemId,
            selection.modifiers.map((modifier) => modifier.id),
            selection.modifiers.map((modifier) => modifier.name),
            selection.modifiers.map((modifier) => modifier.priceDelta),
          ],
        );
      }
      try {
        await captureInventorySnapshot(
          client,
          replacementItemId,
          item.menu_item_id,
          selection.modifiers.map((modifier) => modifier.id),
        );
      } catch (snapshotError) {
        if (
          snapshotError instanceof Error &&
          snapshotError.message === "negative_ingredient_requirement"
        ) {
          await client.query("ROLLBACK");
          return {
            ok: false,
            error: "negative_ingredient_requirement",
            status: 400,
          };
        }
        throw snapshotError;
      }
    } else if (input.quantity !== undefined || input.note !== undefined) {
      await client.query(
        "UPDATE order_items SET quantity = $2, note = $3 WHERE id = $1",
        [input.orderItemId, quantity, note],
      );
    } else {
      await client.query("ROLLBACK");
      return { ok: false, error: "bad_request", status: 400 };
    }

    const totals = await recomputeOrderTotals(client, input.orderId, discount);
    await client.query("COMMIT");
    return {
      ok: true,
      data: { totals, voided: Boolean(input.void), replacementItemId },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
