import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { resolveCartItems, validateItemShape, type CartItemInput } from "@/lib/order-cart";
import { recomputeOrderTotals } from "@/lib/order-totals";
import type { DiscountInput } from "@/lib/orders";
import { getPrimaryLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";

/** Add one or more items to an already-submitted order, while it's still 'open'. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;
  const { id } = await context.params;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: orderRows } = await query<{
    id: string;
    status: string;
    discount_type: "percent" | "amount" | null;
    discount_value: string | null;
  }>("SELECT id, status, discount_type, discount_value FROM orders WHERE id = $1 AND location_id = $2", [
    id,
    location.id,
  ]);
  const order = orderRows[0];
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  if (order.status !== "open") return NextResponse.json({ error: "order_not_open" }, { status: 409 });

  let body: { items?: CartItemInput[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const items = body.items ?? [];
  const shapeError = validateItemShape(items);
  if (shapeError) return NextResponse.json({ error: shapeError }, { status: 400 });

  const resolved = await resolveCartItems(location.id, items);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  const { preparedItems } = resolved;

  const discount: DiscountInput = order.discount_type
    ? { type: order.discount_type, value: Number(order.discount_value ?? 0) }
    : { type: null };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const item of preparedItems) {
      // Adding an item to a live order is also "send to kitchen" (Phase 4).
      const { rows: itemRows } = await client.query<{ id: string }>(
        `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, note, status, sent_to_kitchen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent', now()) RETURNING id`,
        [location.id, id, item.menuItemId, item.name, item.unitPrice, item.quantity, item.note],
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
    const totals = await recomputeOrderTotals(client, id, discount);
    await client.query("COMMIT");
    broadcast(location.id, { type: "order.updated", orderId: id });
    return NextResponse.json({ ok: true, totals });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
