import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { resolveCartItems, validateItemShape, type CartItemInput } from "@/lib/order-cart";
import { computeOrderTotals, type DiscountInput } from "@/lib/orders";
import { ensureSessionForTable } from "@/lib/table-session-service";
import { getPrimaryLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";

/** Open orders for the cashier's "current orders" list. */
export async function GET() {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ orders: [] });

  const { rows: orders } = await query(
    `SELECT o.id, o.order_number, o.type, o.status, o.table_id, dt.name AS table_name,
            o.guest_count, o.subtotal, o.discount, o.tax, o.total, o.note, o.opened_at
       FROM orders o LEFT JOIN dining_tables dt ON dt.id = o.table_id
      WHERE o.location_id = $1 AND o.status = 'open'
      ORDER BY o.opened_at DESC`,
    [location.id],
  );
  return NextResponse.json({ orders });
}

interface CreateOrderBody {
  type?: "dine_in" | "takeaway";
  tableId?: string;
  guestCount?: number;
  note?: string;
  discount?: { type?: "percent" | "amount"; value?: number };
  items?: CartItemInput[];
}

/** Builds the cart, computes totals, and creates Orders + OrderItems (+ modifiers) atomically. */
export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;

  let body: CreateOrderBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.type !== "dine_in" && body.type !== "takeaway") {
    return NextResponse.json({ error: "invalid_order_type" }, { status: 400 });
  }
  const items = body.items ?? [];
  const shapeError = validateItemShape(items);
  if (shapeError) return NextResponse.json({ error: shapeError }, { status: 400 });

  const discountType = body.discount?.type === "percent" || body.discount?.type === "amount" ? body.discount.type : null;
  const discountValue = Number(body.discount?.value ?? 0);
  if (discountType && (!Number.isFinite(discountValue) || discountValue < 0 || (discountType === "percent" && discountValue > 100))) {
    return NextResponse.json({ error: "invalid_discount" }, { status: 400 });
  }
  const discount: DiscountInput = discountType ? { type: discountType, value: discountValue } : { type: null };

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let tableId: string | null = null;
  if (body.type === "dine_in") {
    tableId = body.tableId ?? null;
    if (!tableId) return NextResponse.json({ error: "table_required" }, { status: 400 });
    const { rows: table } = await query<{ id: string; status: string }>(
      "SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active",
      [tableId, location.id],
    );
    if (table.length === 0) return NextResponse.json({ error: "table_not_found" }, { status: 404 });
    if (table[0].status === "cleaning" || table[0].status === "out_of_service") {
      return NextResponse.json({ error: "table_unavailable" }, { status: 409 });
    }
    // A dine-in order joins the table's open session (grouping order rounds),
    // or opens a fresh one below inside the transaction.
  }

  const resolved = await resolveCartItems(location.id, items);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  const { cartLines, preparedItems } = resolved;

  const totals = computeOrderTotals(cartLines, discount);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: counter } = await client.query<{ next_number: string }>(
      `INSERT INTO order_number_counters (location_id, next_number) VALUES ($1, 2)
       ON CONFLICT (location_id) DO UPDATE SET next_number = order_number_counters.next_number + 1
       RETURNING next_number - 1 AS next_number`,
      [location.id],
    );
    const orderNumber = Number(counter[0].next_number);

    const guestCount = Number.isFinite(body.guestCount) ? Number(body.guestCount) : null;
    let tableSessionId: string | null = null;
    if (body.type === "dine_in" && tableId) {
      tableSessionId = await ensureSessionForTable(client, location.id, tableId, session.sub, guestCount);
    }

    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, table_id, table_session_id, guest_count,
              subtotal, discount, discount_type, discount_value, tax, total, note, opened_by)
       VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        location.id,
        orderNumber,
        body.type,
        tableId,
        tableSessionId,
        guestCount,
        totals.subtotal,
        totals.discount,
        discountType,
        discountType ? discountValue : null,
        totals.tax,
        totals.total,
        body.note?.trim() || null,
        session.sub,
      ],
    );
    const orderId = orderRows[0].id;

    for (const item of preparedItems) {
      // Submitting the order *is* "send to kitchen": items land as 'sent'
      // straight away so they appear on the KDS within ~1s (Phase 4).
      const { rows: itemRows } = await client.query<{ id: string }>(
        `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, note, status, sent_to_kitchen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent', now()) RETURNING id`,
        [location.id, orderId, item.menuItemId, item.name, item.unitPrice, item.quantity, item.note],
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
    broadcast(location.id, { type: "order.created", orderId });
    return NextResponse.json({ ok: true, id: orderId, orderNumber, type: body.type, totals });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
