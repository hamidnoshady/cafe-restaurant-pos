import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { recomputeOrderTotals } from "@/lib/order-totals";
import { getOrderDetail } from "@/lib/order-read-service";
import type { DiscountInput } from "@/lib/orders";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";
import { lockOpenOrder } from "@/lib/order-lock";
import { ensureSessionForTable } from "@/lib/table-session-service";

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const detail = await getOrderDetail(location.id, id);
  if (!detail) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  return NextResponse.json(detail);
});

interface PatchBody {
  note?: string;
  discount?: { type?: "percent" | "amount" | null; value?: number };
  customerId?: string | null;
  tableId?: string;
  void?: { reason?: string };
}

/** Update note/discount, or void the whole order — only while status = 'open'. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
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

  if (body.discount !== undefined) {
    const type = body.discount.type === "percent" || body.discount.type === "amount" ? body.discount.type : null;
    const value = Number(body.discount.value ?? 0);
    if (type && (!Number.isFinite(value) || value < 0 || (type === "percent" && value > 100))) {
      return NextResponse.json({ error: "invalid_discount" }, { status: 400 });
    }
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await lockOpenOrder(client, location.id, id);
    if (!locked.ok) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: locked.error }, { status: locked.status });
    }

    if (body.void) {
      const { rowCount } = await client.query(
        `UPDATE orders SET status = 'voided', voided_reason = $2, closed_by = $3, closed_at = now()
          WHERE id = $1 AND status = 'open'
          RETURNING id`,
        [id, body.void.reason?.trim() || null, session.sub],
      );
      if (rowCount !== 1) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "order_not_open" }, { status: 409 });
      }
    } else {
      if (body.customerId !== undefined) {
        if (body.customerId) {
          const { rowCount } = await client.query(
            `SELECT 1 FROM customers WHERE id = $1 AND business_id = $2 AND is_active`,
            [body.customerId, session.businessId],
          );
          if (rowCount !== 1) {
            await client.query("ROLLBACK");
            return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
          }
        }
        await client.query("UPDATE orders SET customer_id = $2 WHERE id = $1", [id, body.customerId || null]);
      }
      if (body.tableId !== undefined) {
        const { rows: tableRows } = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active FOR UPDATE`,
          [body.tableId, location.id],
        );
        if (tableRows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "table_not_found" }, { status: 404 });
        }
        if (tableRows[0].status === "cleaning" || tableRows[0].status === "out_of_service") {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "table_unavailable" }, { status: 409 });
        }
        const tableSessionId = await ensureSessionForTable(client, location.id, body.tableId, session.sub, locked.order.guest_count);
        await client.query(
          `UPDATE orders SET table_id = $2, table_session_id = $3 WHERE id = $1`,
          [id, body.tableId, tableSessionId],
        );
      }
      if (body.note !== undefined) {
        await client.query("UPDATE orders SET note = $2 WHERE id = $1", [id, body.note?.trim() || null]);
      }
      if (body.discount !== undefined) {
        const type = body.discount.type === "percent" || body.discount.type === "amount" ? body.discount.type : null;
        const value = Number(body.discount.value ?? 0);
        const discount: DiscountInput = type ? { type, value } : { type: null };
        const totals = await recomputeOrderTotals(client, id, discount);
        await client.query("COMMIT");
        broadcast(location.id, { type: "order.updated", orderId: id });
        return NextResponse.json({ ok: true, totals });
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  broadcast(location.id, { type: "order.updated", orderId: id });
  return NextResponse.json({ ok: true });
});
