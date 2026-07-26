import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  closeSession,
  computeSessionBill,
  mergeTableIntoSession,
  requestBill,
} from "@/lib/table-session-service";
import { broadcast } from "@/lib/realtime";

/** Session detail: header, its tables, its orders, and the combined bill. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: sessions } = await query(
    `SELECT ts.id, ts.status, ts.primary_table_id, ts.party_size, ts.guest_name, ts.guest_phone,
            ts.reservation_id, ts.note, ts.opened_at, ts.bill_requested_at, ts.closed_at
       FROM table_sessions ts
      WHERE ts.id = $1 AND ts.location_id = $2`,
    [id, location.id],
  );
  if (sessions.length === 0) return NextResponse.json({ error: "session_not_found" }, { status: 404 });

  const { rows: tables } = await query(
    `SELECT dt.id, dt.name, dt.capacity
       FROM table_session_tables tst JOIN dining_tables dt ON dt.id = tst.table_id
      WHERE tst.session_id = $1 AND tst.released_at IS NULL
      ORDER BY dt.name`,
    [id],
  );

  const { rows: orders } = await query(
    `SELECT id, order_number, status, subtotal, discount, tax, total, opened_at
       FROM orders WHERE table_session_id = $1 ORDER BY opened_at`,
    [id],
  );

  const bill = await computeSessionBill(id);

  return NextResponse.json({ session: sessions[0], tables, orders, bill });
}

interface PatchBody {
  action?: "request_bill" | "close" | "merge" | "set_note";
  tableId?: string; // for merge
  note?: string; // for set_note
}

/** Session lifecycle actions. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
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

  if (body.action === "set_note") {
    const { rows } = await query(
      "UPDATE table_sessions SET note = $3 WHERE id = $1 AND location_id = $2 AND status = 'open' RETURNING id",
      [id, location.id, body.note?.trim() || null],
    );
    if (rows.length === 0) return NextResponse.json({ error: "session_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (body.action === "request_bill") {
      await requestBill(client, location.id, id);
    } else if (body.action === "close") {
      await closeSession(client, location.id, id, session.sub);
    } else if (body.action === "merge") {
      if (!body.tableId) throw Object.assign(new Error("table_required"), { code: "table_required", status: 400 });
      await mergeTableIntoSession(client, location.id, id, body.tableId);
    } else {
      throw Object.assign(new Error("bad_request"), { code: "bad_request", status: 400 });
    }
    await client.query("COMMIT");
    broadcast(location.id, { type: "table_session.updated", sessionId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    const code = (err as { code?: string }).code;
    const status = (err as { status?: number }).status;
    if (code) return NextResponse.json({ error: code }, { status: status ?? 409 });
    throw err;
  } finally {
    client.release();
  }
}
