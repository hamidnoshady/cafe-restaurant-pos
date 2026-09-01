/** Server-side reservation helpers (DB-touching). Pure timing math is in ./reservations. */
import type { PoolClient } from "pg";
import { getBusinessDek } from "./business-keys";
import { query } from "./db";
import { decryptOptional, encryptOptional, phoneBlindIndex } from "./field-crypto";
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
  client?: PoolClient,
): Promise<ConflictRow[]> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const { rows } = await run<ConflictRow>(
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

/**
 * Serializes reservation writes against one table, in the caller's
 * transaction. Without this, two near-simultaneous bookings for the same
 * table can both run {@link tableConflicts} before either has committed its
 * INSERT/UPDATE — each sees zero conflicts and both succeed, double-booking
 * the table. Postgres has no row to lock here (the conflict is against a
 * *set* of reservation rows, not one), so this takes a session-scoped
 * advisory lock keyed on the table instead: the second caller blocks until
 * the first's transaction ends, then re-runs its conflict check against the
 * now-committed state.
 */
export async function lockTableForReservationWrite(
  client: PoolClient,
  locationId: string,
  tableId: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `reservation-table:${locationId}:${tableId}`,
  ]);
}

/**
 * Phase 24 Wave 3 — `reservations.customer_phone` is Tier B PII, so it is
 * written as a triple (plaintext twin, `_enc`, `_bidx`) and read back through
 * the ciphertext. These two helpers keep that logic out of the route handlers
 * and in the service layer, where the phase doc puts it; reservations have no
 * `*-service.ts` of their own for persistence, so this is the nearest thing.
 *
 * The DEK is the *business*'s, not the branch's, even though reservations are
 * scoped by `location_id`: a key per branch would hash the same customer's
 * number differently at two branches of one business, and the blind index
 * exists precisely so that lookup crosses that boundary.
 */
export interface ReservationPhoneCiphertext {
  enc: Buffer | null;
  bidx: string | null;
}

export async function encryptReservationPhone(
  businessId: string,
  phone: string | null,
): Promise<ReservationPhoneCiphertext> {
  const dek = await getBusinessDek(businessId);
  if (!dek) return { enc: null, bidx: null };
  return { enc: encryptOptional(phone, dek), bidx: phone ? phoneBlindIndex(phone, dek) : null };
}

/**
 * Replaces `customer_phone` with the decrypted value on rows selected with
 * `customer_phone_enc`, falling back to the plaintext twin for rows the
 * backfill has not reached. Mutates and returns the same array — these rows go
 * straight into a JSON response.
 */
export async function decryptReservationPhones<
  T extends { customer_phone?: string | null; customer_phone_enc?: unknown },
>(businessId: string, rows: T[]): Promise<T[]> {
  const dek = await getBusinessDek(businessId);
  for (const row of rows) {
    row.customer_phone = decryptOptional(row.customer_phone_enc, dek, row.customer_phone ?? null);
    delete row.customer_phone_enc;
  }
  return rows;
}
