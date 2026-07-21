/**
 * Table state machine + bill-splitting — pure functions, integer Rial in/out.
 *
 * State machine (see docs/phases/Phase-3-...): a table moves
 *   free → seated → bill_requested → cleaning → free
 * with free ⇄ out_of_service as a manual maintenance side-track. Reserved is a
 * display overlay derived from upcoming reservations, not a stored transition.
 *
 * Bill splitting produces separately-payable integer-Rial shares that sum
 * EXACTLY to the bill total (no rial is created or lost to rounding).
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

export interface SplitLine {
  /** the line's total charge (post-discount incl. tax), integer Rial */
  amount: Rial;
  /**
   * payer index this line is assigned to (0-based), or null for a shared line
   * that is split evenly across all payers.
   */
  guest: number | null;
}

/**
 * Itemized split: each line is charged to one payer, or (guest = null) shared
 * evenly across all `guests`. Shared lines are pooled and split once with
 * {@link evenSplit} so no rial is lost. Returns `guests` totals summing exactly
 * to the sum of all line amounts.
 */
export function itemizedSplit(lines: SplitLine[], guests: number): Rial[] {
  const n = Math.trunc(guests);
  if (n <= 0) throw new Error("guests must be a positive integer");
  const totals = new Array<number>(n).fill(0);
  let sharedPool = 0;
  for (const line of lines) {
    if (line.guest === null) {
      sharedPool += line.amount;
    } else {
      if (!Number.isInteger(line.guest) || line.guest < 0 || line.guest >= n) {
        throw new Error(`line assigned to out-of-range payer ${line.guest}`);
      }
      totals[line.guest] += line.amount;
    }
  }
  if (sharedPool !== 0) {
    const shares = evenSplit(sharedPool, n);
    for (let i = 0; i < n; i += 1) totals[i] += shares[i];
  }
  return totals;
}
