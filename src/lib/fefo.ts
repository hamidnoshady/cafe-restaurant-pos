/**
 * Phase 27 Wave 2 — first-expired-first-out (FEFO) allocation across batches
 * (pure helper).
 *
 * The sell path consumes batch-tracked stock through this, so the rule lives
 * in exactly one place: the earliest-expiring batch is consumed first, then
 * the next, and so on. A batch with no recorded expiry (`expiryDate: null`)
 * is consumed last — "never first" — because there is nothing to put it at
 * the front of the queue; ties (equal expiry, or several undated batches)
 * keep the caller's order, which the service makes deterministic.
 *
 * Exact decimal arithmetic on quantity strings — the same precision the
 * numeric(24,9) columns carry — and no DB/I/O so it is unit-testable.
 */
import Decimal from "decimal.js";
import { quantityText, subtractQuantity, type QuantityText } from "./inventory-exact";

export interface Batch {
  id: string;
  /** ISO date (YYYY-MM-DD), or null when the batch carries no stated expiry. */
  expiryDate: string | null;
  quantity: string;
}

export interface FefoAllocationLine {
  batchId: string;
  quantity: string;
}

function toDate(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/** A batch is expired on `today` when its expiry date is already in the past — the date itself is still sellable. */
export function isBatchExpired(expiryDate: string | null, today: string): boolean {
  if (!expiryDate) return false;
  return toDate(expiryDate) < toDate(today);
}

/**
 * Which batches are expired as of `today`, in stable input order. The service
 * uses this to refuse a sale and to drive the write-off list.
 */
export function expiredBatches(batches: Batch[], today: string): Batch[] {
  return batches.filter((b) => isBatchExpired(b.expiryDate, today));
}

const compareExpiry = (a: Batch, b: Batch): number => {
  if (a.expiryDate === b.expiryDate) return 0;
  if (a.expiryDate === null) return 1; // undated batches go last
  if (b.expiryDate === null) return -1;
  return toDate(a.expiryDate) - toDate(b.expiryDate);
};

/**
 * Allocate `quantity` across batches first-expired-first-out. Throws
 * `"quantity_underflow"` when the batches hold less than `quantity` in
 * total. Allocation order is deterministic: earliest expiry first, undated
 * last, and stable input order within each group.
 */
export function allocateFefo(batches: Batch[], quantity: string): FefoAllocationLine[] {
  const wanted = quantityText(quantity);
  const sorted = [...batches].sort((a, b) => compareExpiry(a, b) || (batches.indexOf(a) - batches.indexOf(b)));

  let remaining: QuantityText = wanted;
  const result: FefoAllocationLine[] = [];
  for (const batch of sorted) {
    if (new Decimal(remaining).isZero()) break;
    const onHand = quantityText(batch.quantity);
    if (new Decimal(onHand).isZero()) continue;
    const take = new Decimal(remaining).lte(onHand) ? remaining : onHand;
    result.push({ batchId: batch.id, quantity: take });
    remaining = subtractQuantity(remaining, take);
  }

  if (!new Decimal(remaining).isZero()) {
    throw new Error("quantity_underflow");
  }
  return result;
}

/** Total sellable quantity across a list of batches, excluding expired ones. */
export function sellableQuantity(batches: Batch[], today: string): string {
  const total = batches.reduce((sum, b) => {
    if (isBatchExpired(b.expiryDate, today)) return sum;
    return sum.plus(new Decimal(b.quantity));
  }, new Decimal(0));
  return total.toFixed();
}
