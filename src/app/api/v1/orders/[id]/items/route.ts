import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import type { CartItemInput } from "@/lib/order-cart";
import { addItemsToOrder } from "@/lib/order-mutations";
import { broadcast } from "@/lib/realtime";

/** Adds lines through the existing open-order transaction and kitchen flow. */
export const POST = withApiKeyScope(
  async (apiKey, request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const denied = requireApiScope(apiKey.scopes, API_SCOPES.ordersWrite);
    if (denied) return denied;

    const { id } = await context.params;
    let body: { items?: CartItemInput[] };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const result = await addItemsToOrder({
      locationId: apiKey.locationId,
      orderId: id,
      items: body.items ?? [],
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    broadcast(apiKey.locationId, { type: "order.updated", orderId: id });
    return NextResponse.json({ ok: true, ...result.data });
  },
);
