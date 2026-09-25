import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import {
  decryptReservationPhones,
  encryptReservationPhone,
  lockTableForReservationWrite,
  parseDate,
  tableConflicts,
} from "@/lib/reservation-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * List reservations in a time window (default: from 1h ago through 14 days
 * out). `from`/`to` are ISO instants supplied by the client.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reservationsView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ reservations: [] });

  const url = new URL(request.url);
  const from = parseDate(url.searchParams.get("from")) ?? new Date(Date.now() - 60 * 60 * 1000);
  const to = parseDate(url.searchParams.get("to")) ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const { rows: reservations } = await query<{ customer_phone: string | null; customer_phone_enc?: unknown }>(
    `SELECT r.id, r.table_id, dt.name AS table_name, r.customer_name, r.customer_phone, r.customer_phone_enc,
            r.party_size, r.reserved_at, r.duration_minutes, r.status, r.note, r.seated_session_id
       FROM reservations r
       LEFT JOIN dining_tables dt ON dt.id = r.table_id
      WHERE r.location_id = $1 AND r.reserved_at >= $2 AND r.reserved_at <= $3
      ORDER BY r.reserved_at`,
    [location.id, from.toISOString(), to.toISOString()],
  );
  return NextResponse.json({
    reservations: await decryptReservationPhones(session.businessId, reservations),
  });
});

interface CreateBody {
  tableId?: string | null;
  customerName?: string;
  customerPhone?: string;
  partySize?: number;
  reservedAt?: string; // ISO instant
  durationMinutes?: number;
  note?: string;
  allowConflict?: boolean; // manager override of an overlap warning
}

/** Book a reservation. Overlaps on the same table are flagged (409) unless overridden. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reservationsManage);
  if (error) return error;

  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const customerName = body.customerName?.trim();
  if (!customerName) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const reservedAt = parseDate(body.reservedAt);
  if (!reservedAt) return NextResponse.json({ error: "invalid_time" }, { status: 400 });
  if (reservedAt.getTime() < Date.now() - 60 * 60 * 1000) {
    return NextResponse.json({ error: "time_in_past" }, { status: 400 });
  }

  const partySize = Number.isFinite(body.partySize) && Number(body.partySize) > 0 ? Number(body.partySize) : 0;
  if (partySize <= 0) return NextResponse.json({ error: "invalid_party_size" }, { status: 400 });

  const duration =
    Number.isFinite(body.durationMinutes) && Number(body.durationMinutes) > 0
      ? Math.min(600, Math.max(15, Math.round(Number(body.durationMinutes))))
      : 90;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const tableId: string | null = body.tableId ?? null;
  const customerPhone = body.customerPhone?.trim() || null;
  const phoneCipher = await encryptReservationPhone(session.businessId, customerPhone);

  // Booking a table takes the table's advisory lock for the whole
  // check-then-insert sequence, so two near-simultaneous requests for the
  // same table can't both pass the overlap check before either commits (see
  // lockTableForReservationWrite). A table-less reservation has nothing to
  // lock against and skips straight to the insert.
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (tableId) {
      await lockTableForReservationWrite(client, location.id, tableId);

      const { rows: table } = await client.query(
        "SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active",
        [tableId, location.id],
      );
      if (table.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "table_not_found" }, { status: 404 });
      }

      // Overlap detection against other active reservations on the same table.
      const conflicts = await tableConflicts(location.id, tableId, reservedAt, duration, null, client);
      if (conflicts.length > 0 && !body.allowConflict) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "reservation_conflict", conflicts }, { status: 409 });
      }
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO reservations
          (location_id, table_id, customer_name, customer_phone, party_size, reserved_at, duration_minutes, note, created_by,
           customer_phone_enc, customer_phone_bidx)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        location.id,
        tableId,
        customerName,
        customerPhone,
        partySize,
        reservedAt.toISOString(),
        duration,
        body.note?.trim() || null,
        session.sub,
        phoneCipher.enc,
        phoneCipher.bidx,
      ],
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id: rows[0].id });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});
