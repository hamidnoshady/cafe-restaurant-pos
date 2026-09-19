import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getBusinessDayStatus } from "@/lib/business-day-service";
import { closeSession } from "@/lib/table-session-service";
import { broadcast } from "@/lib/realtime";
import {
  completeOrderPayment,
  PAYMENT_METHODS,
  paymentErrorDetails,
  type PaymentMethod,
} from "@/lib/payment-service";
import { paymentFailureFor } from "@/lib/order-payment-errors";

interface PaySessionBody {
  method?: string;
  reference?: string;
  customerId?: string | null;
}

/** Pay all open rounds on a table in one atomic cashier action. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const businessDay = await getBusinessDayStatus(location.id);

  let body: PaySessionBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const method = body.method as PaymentMethod;
  if (!PAYMENT_METHODS.includes(method)) {
    return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
  }

  const client = await getPool().connect();
  const orderIds: string[] = [];
  let amount = 0;
  try {
    await client.query("BEGIN");
    const { rows: sessions } = await client.query<{ id: string }>(
      `SELECT id FROM table_sessions
        WHERE id = $1 AND location_id = $2 AND status = 'open'
        FOR UPDATE`,
      [id, location.id],
    );
    if (sessions.length === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "session_not_found" }, { status: 404 });
    }

    const { rows: orders } = await client.query<{ id: string; total: string }>(
      `SELECT id, total FROM orders
        WHERE table_session_id = $1 AND location_id = $2 AND status = 'open'
        ORDER BY opened_at, id
        FOR UPDATE`,
      [id, location.id],
    );
    if (orders.length === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "no_open_orders" }, { status: 409 });
    }

    for (const order of orders) {
      await completeOrderPayment({
        client,
        businessId: session.businessId,
        locationId: location.id,
        orderId: order.id,
        method,
        reference: body.reference,
        customerId: body.customerId?.trim() || null,
        businessDate: businessDay?.businessDate,
        receivedBy: session.sub,
      });
      orderIds.push(order.id);
      amount += Number(order.total);
    }
    await closeSession(client, location.id, id, session.sub);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    const details = paymentErrorDetails(err);
    if (details) return NextResponse.json({ error: details.error }, { status: details.status });
    const failure = paymentFailureFor(err);
    if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status });
    throw err;
  } finally {
    client.release();
  }

  for (const orderId of orderIds) broadcast(location.id, { type: "order.updated", orderId });
  broadcast(location.id, { type: "table_session.updated", sessionId: id });
  return NextResponse.json({ ok: true, amount, orderCount: orderIds.length, method });
});
