import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { recomputeOrderTotals } from "@/lib/order-totals";
import type { DiscountInput } from "@/lib/orders";
import { getPrimaryLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";

const MAX_QTY = 50;

/** Change an item's quantity, or void it — only while the order is still 'open'. */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string; itemId: string }> },
) {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const { id, itemId } = await context.params;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: orderRows } = await query<{
    status: string;
    discount_type: "percent" | "amount" | null;
    discount_value: string | null;
  }>("SELECT status, discount_type, discount_value FROM orders WHERE id = $1 AND location_id = $2", [
    id,
    location.id,
  ]);
  const order = orderRows[0];
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  if (order.status !== "open") return NextResponse.json({ error: "order_not_open" }, { status: 409 });

  const { rows: itemRows } = await query<{ id: string; status: string }>(
    "SELECT id, status FROM order_items WHERE id = $1 AND order_id = $2",
    [itemId, id],
  );
  const item = itemRows[0];
  if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  if (item.status === "voided") return NextResponse.json({ error: "item_already_voided" }, { status: 409 });

  let body: { quantity?: number; void?: { reason?: string } };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const discount: DiscountInput = order.discount_type
    ? { type: order.discount_type, value: Number(order.discount_value ?? 0) }
    : { type: null };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    if (body.void) {
      await client.query(
        "UPDATE order_items SET status = 'voided', void_reason = $2 WHERE id = $1",
        [itemId, body.void.reason?.trim() || null],
      );
    } else if (body.quantity !== undefined) {
      const quantity = Number(body.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_QTY) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "invalid_item" }, { status: 400 });
      }
      await client.query("UPDATE order_items SET quantity = $2 WHERE id = $1", [itemId, quantity]);
    } else {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const totals = await recomputeOrderTotals(client, id, discount);
    await client.query("COMMIT");
    broadcast(location.id, body.void
      ? { type: "order.item_status", orderId: id, itemId, status: "voided" }
      : { type: "order.updated", orderId: id });
    return NextResponse.json({ ok: true, totals });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
