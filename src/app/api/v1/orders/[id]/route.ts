import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { getOrderDetail, withoutCustomerContact } from "@/lib/order-read-service";

/** Returns one order only when it belongs to the authenticated key's branch. */
export const GET = withApiKeyScope(
  async (apiKey, _request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const denied = requireApiScope(apiKey.scopes, API_SCOPES.ordersRead);
    if (denied) return denied;

    const { id } = await context.params;
    const detail = await getOrderDetail(apiKey.locationId, id);
    if (!detail) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
    return NextResponse.json({ ...detail, order: withoutCustomerContact(detail.order) });
  },
);
