import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { type CartItemInput } from "@/lib/order-cart";
import { createOrder } from "@/lib/order-mutations";
import { listOrders } from "@/lib/order-read-service";
import type { DiscountInput } from "@/lib/orders";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";

/** Open orders for the cashier's "current orders" list. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ orders: [] });

  return NextResponse.json({ orders: await listOrders(location.id, { status: "open" }) });
});

interface CreateOrderBody {
  type?: "dine_in" | "takeaway" | "delivery";
  tableId?: string;
  guestCount?: number;
  note?: string;
  discount?: { type?: "percent" | "amount"; value?: number };
  items?: CartItemInput[];
  delivery?: { address?: string; phone?: string; fee?: number; courierId?: string; note?: string };
}

/** Builds the cart, computes totals, and creates Orders + OrderItems (+ modifiers) atomically. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;

  let body: CreateOrderBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.type !== "dine_in" && body.type !== "takeaway" && body.type !== "delivery") {
    return NextResponse.json({ error: "invalid_order_type" }, { status: 400 });
  }
  const items = body.items ?? [];

  const discountType = body.discount?.type === "percent" || body.discount?.type === "amount" ? body.discount.type : null;
  const discountValue = Number(body.discount?.value ?? 0);
  if (discountType && (!Number.isFinite(discountValue) || discountValue < 0 || (discountType === "percent" && discountValue > 100))) {
    return NextResponse.json({ error: "invalid_discount" }, { status: 400 });
  }
  const discount: DiscountInput = discountType ? { type: discountType, value: discountValue } : { type: null };

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const guestCount = Number.isFinite(body.guestCount) ? Number(body.guestCount) : null;
  const result = await createOrder({
    locationId: location.id,
    type: body.type,
    tableId: body.tableId ?? null,
    guestCount,
    note: body.note ?? null,
    discount,
    items,
    openedBy: session.sub,
    delivery: body.type === "delivery" && body.delivery
      ? {
          address: body.delivery.address ?? "",
          phone: body.delivery.phone ?? null,
          fee: body.delivery.fee ?? 0,
          courierId: body.delivery.courierId ?? null,
          note: body.delivery.note ?? null,
        }
      : null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  broadcast(location.id, { type: "order.created", orderId: result.data.id });
  return NextResponse.json({ ok: true, ...result.data });
});
