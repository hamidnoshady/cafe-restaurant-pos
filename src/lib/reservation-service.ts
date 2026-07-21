/** Server-side reservation helpers (DB-touching). Pure timing math is in ./reservations. */
import { query } from "./db";
import { ACTIVE_RESERVATION_STATUSES, findConflicts } from "./reservations";

/** Parse an ISO string into a Date, or null if invalid/empty. */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type ConflictRow = {
  id: string;
  customer_name: string;
  reserved_at: string;
  duration_minutes: number;
};

/**
 * Existing active (booked/seated) reservations on `tableId` whose window
 * overlaps [reservedAt, +duration). `excludeId` skips a row (when editing).
 */
export async function tableConflicts(
  locationId: string,
  tableId: string,
  reservedAt: Date,
  durationMinutes: number,
  excludeId: string | null,
): Promise<ConflictRow[]> {
  const { rows } = await query<ConflictRow>(
    `SELECT id, customer_name, reserved_at, duration_minutes
       FROM reservations
      WHERE location_id = $1 AND table_id = $2 AND status = ANY($3::reservation_status[])`,
    [locationId, tableId, [...ACTIVE_RESERVATION_STATUSES]],
  );
  const candidate = { id: excludeId ?? undefined, startMs: reservedAt.getTime(), durationMinutes };
  const existing = rows.map((r) => ({
    id: r.id,
    startMs: new Date(r.reserved_at).getTime(),
    durationMinutes: r.duration_minutes,
  }));
  const conflicts = findConflicts(candidate, existing);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return conflicts.map((c) => byId.get(c.id!)).filter((r): r is ConflictRow => Boolean(r));
}
