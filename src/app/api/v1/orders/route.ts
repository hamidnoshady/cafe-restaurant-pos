import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { type CartItemInput } from "@/lib/order-cart";
import { createOrder } from "@/lib/order-mutations";
import { isOrderStatus, listOrders, withoutCustomerContact } from "@/lib/order-read-service";
import type { DiscountInput } from "@/lib/orders";
import { broadcast } from "@/lib/realtime";

const DEFAULT_ORDER_LIMIT = 50;
const MAX_ORDER_LIMIT = 100;

function parseLimit(value: string | null): number | null {
  if (value === null) return DEFAULT_ORDER_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ORDER_LIMIT) return null;
  return parsed;
}

/** Lists orders from the authenticated API key's one branch. */
export const GET = withApiKeyScope(async (apiKey, request: NextRequest) => {
  const denied = requireApiScope(apiKey.scopes, API_SCOPES.ordersRead);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const rawStatus = searchParams.get("status");
  if (rawStatus !== null && !isOrderStatus(rawStatus)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  const limit = parseLimit(searchParams.get("limit"));
  if (limit === null) return NextResponse.json({ error: "invalid_limit" }, { status: 400 });

  const orders = await listOrders(apiKey.locationId, { status: rawStatus ?? undefined, limit });
  return NextResponse.json({ orders: orders.map(withoutCustomerContact) });
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

/** Creates an order through the same transactional mutation used by the POS. */
export const POST = withApiKeyScope(async (apiKey, request: NextRequest) => {
  const denied = requireApiScope(apiKey.scopes, API_SCOPES.ordersWrite);
  if (denied) return denied;

  let body: CreateOrderBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.type !== "dine_in" && body.type !== "takeaway" && body.type !== "delivery") {
    return NextResponse.json({ error: "invalid_order_type" }, { status: 400 });
  }

  const discountType =
    body.discount?.type === "percent" || body.discount?.type === "amount" ? body.discount.type : null;
  const discountValue = Number(body.discount?.value ?? 0);
  if (
    discountType &&
    (!Number.isFinite(discountValue) ||
      discountValue < 0 ||
      (discountType === "percent" && discountValue > 100))
  ) {
    return NextResponse.json({ error: "invalid_discount" }, { status: 400 });
  }
  const discount: DiscountInput = discountType ? { type: discountType, value: discountValue } : { type: null };

  const guestCount = Number.isFinite(body.guestCount) ? Number(body.guestCount) : null;
  const result = await createOrder({
    locationId: apiKey.locationId,
    type: body.type,
    tableId: body.tableId ?? null,
    guestCount,
    note: body.note ?? null,
    discount,
    items: body.items ?? [],
    // A machine credential never impersonates a staff member.
    openedBy: null,
    delivery:
      body.type === "delivery" && body.delivery
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

  broadcast(apiKey.locationId, { type: "order.created", orderId: result.data.id });
  return NextResponse.json({ ok: true, ...result.data });
});
