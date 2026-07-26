import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { recomputeOrderTotals } from "@/lib/order-totals";
import { lockOpenOrder } from "@/lib/order-lock";
import type { DiscountInput } from "@/lib/orders";
import { resolveActiveLocation } from "@/lib/setup-state";
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

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { quantity?: number; void?: { reason?: string } };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await lockOpenOrder(client, location.id, id);
    if (!locked.ok) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: locked.error }, { status: locked.status });
    }
    const { rows: itemRows } = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM order_items WHERE id = $1 AND order_id = $2",
      [itemId, id],
    );
    const item = itemRows[0];
    if (!item) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "item_not_found" }, { status: 404 });
    }
    if (item.status === "voided") {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "item_already_voided" }, { status: 409 });
    }
    const discount: DiscountInput = locked.order.discount_type
      ? { type: locked.order.discount_type, value: Number(locked.order.discount_value ?? 0) }
      : { type: null };

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
