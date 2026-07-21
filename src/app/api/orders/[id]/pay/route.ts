import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { getPrimaryLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";

const PAYMENT_METHODS = ["cash", "card", "card_to_card", "online", "credit"] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

interface PayBody {
  method?: string;
  reference?: string;
}

/**
 * Checkout: records the payment and completes the order. This is the
 * "payment completion" trigger Phase 5's cash-drawer/receipt exit criteria
 * hook into — nothing in the app reached order status 'completed' before
 * this (the table-session `close` action just frees the table; see
 * src/lib/table-session-service.ts's closeSession comment). v1 keeps this
 * simple: one full payment per order, no split/partial payments — a
 * dine-in table session's "split the bill" flow (Phase 3,
 * /api/table-sessions/[id]/split) computes shares for display, but each
 * share is still collected as its own order-level payment.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const { id } = await context.params;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: PayBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const method = body.method as PaymentMethod;
  if (!PAYMENT_METHODS.includes(method)) {
    return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
  }

  const { rows } = await query<{ id: string; status: string; total: string }>(
    "SELECT id, status, total FROM orders WHERE id = $1 AND location_id = $2",
    [id, location.id],
  );
  const order = rows[0];
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  if (order.status !== "open") return NextResponse.json({ error: "order_not_open" }, { status: 409 });

  const total = Number(order.total);
  if (total > 0) {
    await query(
      `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [location.id, id, method, total, body.reference?.trim() || null, session.sub],
    );
  }
  await query(
    "UPDATE orders SET status = 'completed', closed_by = $2, closed_at = now() WHERE id = $1",
    [id, session.sub],
  );

  broadcast(location.id, { type: "order.updated", orderId: id });
  return NextResponse.json({ ok: true, amount: total, method });
}
