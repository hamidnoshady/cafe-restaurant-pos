import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getConnection } from "@/lib/integrations/connections-service";
import { enqueueOperation, storeOrdersFor } from "@/lib/integrations/woo-ops-service";

/**
 * The store's orders, and the two operations an owner asks for against one:
 * change its status, or refund it.
 *
 * Both are queued, never applied inline. In plugin mode the app cannot reach
 * the store at all, so an inline call would simply fail there; going through
 * the outbox means the same button works for both connection modes and gets
 * retry, backoff and a visible trail for free.
 */
export const GET = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const connection = await getConnection(session.businessId, id);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const orders = await storeOrdersFor(session.businessId, id, 100);
  return NextResponse.json({ orders });
});

/**
 * One operation against one remote order.
 *
 * `action: "status"` and `action: "refund"` are the whole surface. A refund
 * never moves money through the payment gateway — `api_refund` is forced
 * false on the way in and again in the drain — because recording that a
 * refund was agreed is this app's business and crediting a card is the
 * store's.
 */
export const POST = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const connection = await getConnection(session.businessId, id);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { action?: string; remoteId?: string; status?: string; amount?: string; reason?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const remoteId = String(body.remoteId ?? "").trim();
  if (!remoteId) return NextResponse.json({ error: "missing_remote_id" }, { status: 400 });

  try {
    if (body.action === "status") {
      const { sanitizeOrderStatus } = await import("@/lib/integrations/woo-ops-service");
      const status = sanitizeOrderStatus(String(body.status ?? ""));
      await enqueueOperation(session.businessId, id, "order_status", remoteId, { status });
      return NextResponse.json({ ok: true, queued: true });
    }
    if (body.action === "refund") {
      const { sanitizeRefund } = await import("@/lib/integrations/woo-ops-service");
      const refund = sanitizeRefund({ amount: body.amount, reason: body.reason });
      await enqueueOperation(session.businessId, id, "refund_create", remoteId, refund);
      return NextResponse.json({ ok: true, queued: true });
    }
    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } catch (err) {
    const message = (err as Error).message;
    const known = ["invalid_order_status", "invalid_refund_amount"];
    return NextResponse.json({ error: message }, { status: known.includes(message) ? 400 : 500 });
  }
});
