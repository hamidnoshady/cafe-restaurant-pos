/**
 * Reservation timing logic — pure functions, framework-free.
 *
 * A reservation holds a table for a window [reserved_at, reserved_at + turn].
 * Two reservations on the SAME table conflict when their windows overlap.
 * Times are epoch-millisecond numbers here (the API converts to/from
 * timestamptz at the edge); durations are minutes.
 */

export interface ReservationWindow {
  /** distinguishes a row from itself when re-checking an edit; optional */
  id?: string;
  /** reservation start, epoch ms */
  startMs: number;
  durationMinutes: number;
}

/** Reservation statuses that still hold a table (and so can conflict). */
export const ACTIVE_RESERVATION_STATUSES = ["booked", "seated"] as const;

const MINUTE_MS = 60_000;

export function windowEndMs(w: ReservationWindow): number {
  return w.startMs + w.durationMinutes * MINUTE_MS;
}

/** Half-open interval overlap: touching end-to-start does NOT overlap. */
export function windowsOverlap(a: ReservationWindow, b: ReservationWindow): boolean {
  return a.startMs < windowEndMs(b) && b.startMs < windowEndMs(a);
}

/**
 * Returns every existing window whose interval overlaps `candidate`. A row
 * with the same `id` as the candidate is skipped (so editing a reservation
 * doesn't conflict with itself).
 */
export function findConflicts(
  candidate: ReservationWindow,
  existing: ReservationWindow[],
): ReservationWindow[] {
  return existing.filter((e) => e.id !== candidate.id && windowsOverlap(candidate, e));
}

/**
 * True once a booked reservation is `graceMinutes` past its start with nobody
 * seated — the UI uses this to flag likely no-shows. Auto-cancellation is not
 * performed; marking no-show stays a manual action.
 */
export const NO_SHOW_GRACE_MINUTES = 15;

export function isNoShowOverdue(startMs: number, nowMs: number, graceMinutes = NO_SHOW_GRACE_MINUTES): boolean {
  return nowMs >= startMs + graceMinutes * MINUTE_MS;
}
