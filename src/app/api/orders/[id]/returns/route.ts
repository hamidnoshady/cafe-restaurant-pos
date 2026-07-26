import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { positiveQuantityText, rialText } from "@/lib/inventory-exact";
import { createCustomerReturn } from "@/lib/customer-return-service";
import { resolveActiveLocation } from "@/lib/setup-state";

export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  let body: {
    refundMethod?: "cash" | "card" | "card_to_card" | "online" | "credit";
    refundAmountRial?: string;
    reason?: string;
    idempotencyKey?: string;
    lines?: Array<{ orderItemId?: string; quantity?: string; disposition?: "restockable" | "discarded" }>;
  };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { id } = await context.params;
    const result = await createCustomerReturn(client, {
      businessId: session.businessId, locationId: location.id, orderId: id,
      refundMethod: body.refundMethod ?? "cash", refundAmount: rialText(body.refundAmountRial ?? ""),
      reason: body.reason ?? "", idempotencyKey: body.idempotencyKey ?? "", createdBy: session.sub,
      lines: (body.lines ?? []).map((line) => ({
        orderItemId: line.orderItemId ?? "", quantity: positiveQuantityText(line.quantity ?? ""),
        disposition: line.disposition ?? "discarded",
      })),
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (caught) {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: (caught as Error).message }, { status: 409 });
  } finally { client.release(); }
});
