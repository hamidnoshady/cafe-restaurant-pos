import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { assignCourier, transitionDelivery } from "@/lib/delivery-service";
import { isDeliveryStatus } from "@/lib/delivery";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";

interface PatchBody {
  action?: "assign" | "status";
  /** assign: courier to set (null clears it). */
  courierId?: string | null;
  /** status: the target delivery_status. */
  status?: string;
}

/** Drive a delivery through its lifecycle: assign/clear a courier, or advance its status. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.action === "assign") {
    const result = await assignCourier(location.id, id, body.courierId ?? null);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    broadcast(location.id, { type: "order.updated", orderId: result.data.order_id });
    return NextResponse.json({ ok: true, delivery: result.data });
  }

  if (body.action === "status") {
    if (!body.status || !isDeliveryStatus(body.status)) {
      return NextResponse.json({ error: "invalid_delivery_status" }, { status: 400 });
    }
    const result = await transitionDelivery(location.id, id, body.status);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    broadcast(location.id, { type: "order.updated", orderId: result.data.order_id });
    return NextResponse.json({ ok: true, delivery: result.data });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
}
