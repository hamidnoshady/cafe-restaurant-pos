import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { parseDate, tableConflicts } from "@/lib/reservation-service";
import { getPrimaryLocation } from "@/lib/setup-state";
import { openSession } from "@/lib/table-session-service";

type ReservationRow = {
  id: string;
  table_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  party_size: number;
  reserved_at: string;
  duration_minutes: number;
  status: string;
  seated_session_id: string | null;
};

async function loadReservation(locationId: string, id: string): Promise<ReservationRow | null> {
  const { rows } = await query<ReservationRow>(
    `SELECT id, table_id, customer_name, customer_phone, party_size, reserved_at,
            duration_minutes, status, seated_session_id
       FROM reservations WHERE id = $1 AND location_id = $2`,
    [id, locationId],
  );
  return rows[0] ?? null;
}

interface PatchBody {
  action?: "cancel" | "no_show" | "seat" | "update";
  // update fields:
  tableId?: string | null;
  customerName?: string;
  customerPhone?: string;
  partySize?: number;
  reservedAt?: string;
  durationMinutes?: number;
  note?: string;
  allowConflict?: boolean;
  // seat: which tables to open the session on (defaults to the reserved table)
  tableIds?: string[];
}

/** Update reservation fields, change its status, or seat it (opens a session). */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;
  const { id } = await context.params;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const reservation = await loadReservation(location.id, id);
  if (!reservation) return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.action === "cancel" || body.action === "no_show") {
    if (reservation.status !== "booked") {
      return NextResponse.json({ error: "reservation_not_booked" }, { status: 409 });
    }
    const to = body.action === "cancel" ? "cancelled" : "no_show";
    await query("UPDATE reservations SET status = $2::reservation_status, updated_at = now() WHERE id = $1", [id, to]);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "seat") {
    return seatReservation(location.id, reservation, body, session.sub);
  }

  // Default: edit fields (only while still booked).
  if (reservation.status !== "booked") {
    return NextResponse.json({ error: "reservation_not_booked" }, { status: 409 });
  }
  return updateReservation(location.id, reservation, body);
}

async function seatReservation(
  locationId: string,
  reservation: ReservationRow,
  body: PatchBody,
  userId: string,
) {
  if (reservation.status !== "booked") {
    return NextResponse.json({ error: "reservation_not_booked" }, { status: 409 });
  }
  const tableIds = (body.tableIds?.filter(Boolean) ?? []).length
    ? body.tableIds!.filter(Boolean)
    : reservation.table_id
      ? [reservation.table_id]
      : [];
  if (tableIds.length === 0) return NextResponse.json({ error: "table_required" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { id: sessionId } = await openSession(client, {
      locationId,
      tableIds,
      partySize: reservation.party_size,
      guestName: reservation.customer_name,
      guestPhone: reservation.customer_phone,
      reservationId: reservation.id,
      openedBy: userId,
    });
    await client.query(
      "UPDATE reservations SET status = 'seated', seated_session_id = $2, updated_at = now() WHERE id = $1",
      [reservation.id, sessionId],
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, sessionId });
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

async function updateReservation(locationId: string, reservation: ReservationRow, body: PatchBody) {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = $${++i}`);
    values.push(val);
  };

  // Resolve the effective table + timing for a conflict re-check.
  let effectiveTableId = reservation.table_id;
  let effectiveReservedAt = new Date(reservation.reserved_at);
  let effectiveDuration = reservation.duration_minutes;

  if (body.tableId !== undefined) {
    if (body.tableId) {
      const { rows } = await query("SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active", [
        body.tableId,
        locationId,
      ]);
      if (rows.length === 0) return NextResponse.json({ error: "table_not_found" }, { status: 404 });
    }
    effectiveTableId = body.tableId || null;
    set("table_id", effectiveTableId);
  }
  if (body.reservedAt !== undefined) {
    const d = parseDate(body.reservedAt);
    if (!d) return NextResponse.json({ error: "invalid_time" }, { status: 400 });
    effectiveReservedAt = d;
    set("reserved_at", d.toISOString());
  }
  if (body.durationMinutes !== undefined) {
    if (!Number.isFinite(body.durationMinutes) || Number(body.durationMinutes) <= 0) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    effectiveDuration = Math.min(600, Math.max(15, Math.round(Number(body.durationMinutes))));
    set("duration_minutes", effectiveDuration);
  }
  if (body.customerName !== undefined) {
    const name = body.customerName.trim();
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    set("customer_name", name);
  }
  if (body.customerPhone !== undefined) set("customer_phone", body.customerPhone?.trim() || null);
  if (body.partySize !== undefined) {
    const n = Number(body.partySize);
    if (!Number.isFinite(n) || n <= 0) return NextResponse.json({ error: "invalid_party_size" }, { status: 400 });
    set("party_size", Math.round(n));
  }
  if (body.note !== undefined) set("note", body.note?.trim() || null);

  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // Re-check overlap if the table/time/duration moved.
  if (
    effectiveTableId &&
    (body.tableId !== undefined || body.reservedAt !== undefined || body.durationMinutes !== undefined)
  ) {
    const conflicts = await tableConflicts(
      locationId,
      effectiveTableId,
      effectiveReservedAt,
      effectiveDuration,
      reservation.id,
    );
    if (conflicts.length > 0 && !body.allowConflict) {
      return NextResponse.json({ error: "reservation_conflict", conflicts }, { status: 409 });
    }
  }

  set("updated_at", new Date().toISOString());
  await query(`UPDATE reservations SET ${fields.join(", ")} WHERE id = $1`, [reservation.id, ...values]);
  return NextResponse.json({ ok: true });
}

/** Delete a reservation outright (rarely needed; cancel is preferred). */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const reservation = await loadReservation(location.id, id);
  if (!reservation) return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });

  await query("DELETE FROM reservations WHERE id = $1", [id]);
  return NextResponse.json({ ok: true });
}
