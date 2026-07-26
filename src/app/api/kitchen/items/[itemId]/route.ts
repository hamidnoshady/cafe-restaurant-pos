import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { canKitchenBump, canMarkServed, type OrderItemStatus } from "@/lib/order-item-status";
import { broadcast } from "@/lib/realtime";

/**
 * Kitchen "bump" (sent→preparing→ready) and waiter/cashier "served"
 * (ready→served) transitions, kept separate from the cashier-only
 * quantity/void endpoint at /api/orders/[id]/items/[itemId].
 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ itemId: string }> }) {
  const { session, error } = await requireRole("owner", "manager", "kitchen", "waiter", "cashier");
  if (error) return error;
  const { itemId } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { status?: OrderItemStatus };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const to = body.status;
  if (to !== "preparing" && to !== "ready" && to !== "served") {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }

  const { rows } = await query<{ id: string; status: OrderItemStatus; order_id: string }>(
    `SELECT oi.id, oi.status, oi.order_id
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = $1 AND oi.location_id = $2 AND o.status = 'open'`,
    [itemId, location.id],
  );
  const item = rows[0];
  if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const canKitchen = ["owner", "manager", "kitchen"].includes(session.role) && canKitchenBump(item.status, to);
  const canServe = ["owner", "manager", "waiter", "cashier"].includes(session.role) && canMarkServed(item.status, to);
  if (!canKitchen && !canServe) {
    return NextResponse.json({ error: "invalid_transition" }, { status: 409 });
  }

  if (to === "ready") {
    await query("UPDATE order_items SET status = $2, ready_at = now() WHERE id = $1", [itemId, to]);
  } else {
    await query("UPDATE order_items SET status = $2 WHERE id = $1", [itemId, to]);
  }

  broadcast(location.id, { type: "order.item_status", orderId: item.order_id, itemId, status: to });
  return NextResponse.json({ ok: true });
}
