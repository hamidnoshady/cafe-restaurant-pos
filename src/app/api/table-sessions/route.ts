import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { openSession } from "@/lib/table-session-service";
import { broadcast } from "@/lib/realtime";

/** Open table sessions (with their tables), for a management/list view. */
export async function GET() {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ sessions: [] });

  const { rows: sessions } = await query(
    `SELECT ts.id, ts.primary_table_id, ts.party_size, ts.guest_name, ts.guest_phone,
            ts.opened_at, ts.bill_requested_at, ts.note,
            COALESCE(json_agg(json_build_object('id', dt.id, 'name', dt.name)
                     ORDER BY dt.name) FILTER (WHERE dt.id IS NOT NULL), '[]') AS tables,
            (SELECT COALESCE(SUM(o.total), 0) FROM orders o
               WHERE o.table_session_id = ts.id AND o.status != 'voided') AS total
       FROM table_sessions ts
       LEFT JOIN table_session_tables tst ON tst.session_id = ts.id AND tst.released_at IS NULL
       LEFT JOIN dining_tables dt ON dt.id = tst.table_id
      WHERE ts.location_id = $1 AND ts.status = 'open'
      GROUP BY ts.id
      ORDER BY ts.opened_at`,
    [location.id],
  );
  return NextResponse.json({ sessions });
}

/** Seat a walk-in: open a session on one or more free tables. */
export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;

  let body: { tableIds?: string[]; tableId?: string; partySize?: number; guestName?: string; guestPhone?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const tableIds = (body.tableIds ?? (body.tableId ? [body.tableId] : [])).filter(Boolean);
  if (tableIds.length === 0) return NextResponse.json({ error: "table_required" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const partySize = Number.isFinite(body.partySize) && Number(body.partySize) > 0 ? Number(body.partySize) : null;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { id } = await openSession(client, {
      locationId: location.id,
      tableIds,
      partySize,
      guestName: body.guestName?.trim() || null,
      guestPhone: body.guestPhone?.trim() || null,
      openedBy: session.sub,
    });
    await client.query("COMMIT");
    broadcast(location.id, { type: "table_session.updated", sessionId: id });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    await client.query("ROLLBACK");
    const code = (err as { code?: string }).code;
    const status = (err as { status?: number }).status;
    if (code && status) return NextResponse.json({ error: code }, { status });
    throw err;
  } finally {
    client.release();
  }
}
