/**
 * Table state machine + bill-splitting — pure functions, integer Rial in/out.
 *
 * State machine: a table moves
 *   free → seated → free
 * on the ordinary path, because settling the session's last active order frees
 * its tables automatically (see releaseTableAfterOrderSettled). 'cleaning' is
 * an optional manual beat a floor can choose to insert, and free ⇄
 * out_of_service is the maintenance side-track. Reserved is a display overlay
 * derived from upcoming reservations, not a stored transition.
 *
 * 'bill_requested' is legacy: it was set by a table-level "request the bill"
 * action that no longer exists. It stays in the type and the labels so tables
 * left in that state by the old flow still render and can still be moved out
 * of it — no code path puts a table into it any more.
 *
 * evenSplit remains for the assistant's read-only "what would each guest owe"
 * preview: integer-Rial shares that sum EXACTLY to the bill total, so no rial
 * is created or lost to rounding. The itemized variant went with the
 * table-level split-bill screen that used to be its only caller — a bill is an
 * order's, and an order is settled whole at POST /api/orders/[id]/pay.
 */
import type { Rial } from "./money";

export type TableStatus = "free" | "seated" | "bill_requested" | "cleaning" | "out_of_service";

/** Allowed manual/lifecycle transitions between table states. */
const TABLE_TRANSITIONS: Record<TableStatus, TableStatus[]> = {
  free: ["seated", "out_of_service"],
  seated: ["bill_requested", "cleaning", "free"],
  bill_requested: ["cleaning", "seated", "free"],
  cleaning: ["free", "out_of_service"],
  out_of_service: ["free"],
};

export function canTransitionTable(from: TableStatus, to: TableStatus): boolean {
  return TABLE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Persian labels for the table states (display layer). */
export const TABLE_STATUS_LABELS: Record<TableStatus, string> = {
  free: "آزاد",
  seated: "مشغول",
  bill_requested: "درخواست صورتحساب",
  cleaning: "نیازمند نظافت",
  out_of_service: "خارج از سرویس",
};

/**
 * Even split of a bill total across `guests` payers. Returns `guests`
 * non-negative integers summing exactly to `total`; the remainder rial are
 * handed one-each to the earliest payers so shares differ by at most 1 rial.
 */
export function evenSplit(total: Rial, guests: number): Rial[] {
  const n = Math.trunc(guests);
  if (n <= 0) throw new Error("guests must be a positive integer");
  const base = Math.trunc(total / n);
  let remainder = total - base * n; // 0..n-1 (or negative if total < 0)
  const step = remainder >= 0 ? 1 : -1;
  remainder = Math.abs(remainder);
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? step : 0));
}
