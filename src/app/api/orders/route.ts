import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { type CartItemInput } from "@/lib/order-cart";
import { createOrder } from "@/lib/order-mutations";
import type { DiscountInput } from "@/lib/orders";
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

  const discountType = body.discount?.type === "percent" || body.discount?.type === "amount" ? body.discount.type : null;
  const discountValue = Number(body.discount?.value ?? 0);
  if (discountType && (!Number.isFinite(discountValue) || discountValue < 0 || (discountType === "percent" && discountValue > 100))) {
    return NextResponse.json({ error: "invalid_discount" }, { status: 400 });
  }
  const discount: DiscountInput = discountType ? { type: discountType, value: discountValue } : { type: null };

  const location = await getPrimaryLocation(session.businessId);
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
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  broadcast(location.id, { type: "order.created", orderId: result.data.id });
  return NextResponse.json({ ok: true, ...result.data });
}
