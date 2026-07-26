/**
 * Phase 16 — AR subledger, the pure part.
 *
 * A credit order posts its Accounts Receivable debit in full the instant
 * it's rung up (no partial/unpaid order status — see
 * postExactOrderPaymentEntry in ledger-service.ts), so there is no per-order
 * "amount still owed" already tracked anywhere. Aging has to reconstruct it:
 * given a customer's invoices (their credit-order AR debits) and receipts
 * (payments recorded against their balance), apply the receipts FIFO against
 * the oldest invoices first and see what's left of each one as of a date.
 *
 * DB orchestration (fetching the lines, resolving customer names) lives in
 * ar-service.ts and is not unit-tested directly, per repo convention.
 */

export interface ArInvoice {
  id: string;
  date: string; // ISO date
  amount: number; // Rial, positive
}

export interface ArReceipt {
  id: string;
  date: string; // ISO date
  amount: number; // Rial, positive
}

export type AgingBucket = "current" | "d31_60" | "d61_90" | "over90";

export const AGING_BUCKETS: AgingBucket[] = ["current", "d31_60", "d61_90", "over90"];

/** 0-30 days old = current, then 30-day buckets out to 90+. */
export function bucketForAge(ageDays: number): AgingBucket {
  if (ageDays <= 30) return "current";
  if (ageDays <= 60) return "d31_60";
  if (ageDays <= 90) return "d61_90";
  return "over90";
}

export interface AgedInvoice extends ArInvoice {
  outstanding: number;
  ageDays: number;
  bucket: AgingBucket;
}

/**
 * Applies the total of `receipts` against `invoices` oldest-first (FIFO),
 * returning only the invoices still carrying a balance as of `asOfDate`, each
 * with its remaining amount and age bucket. Callers should already have
 * filtered both lists to dates on or before `asOfDate`.
 *
 * FIFO against the customer's total rather than matching a receipt to a
 * specific invoice: nothing records which invoice a receipt was "for" (the
 * product decision was a running balance per customer, not per-invoice
 * allocation), so oldest-first is the standard, deterministic stand-in.
 */
export function ageInvoices(invoices: ArInvoice[], receipts: ArReceipt[], asOfDate: string): AgedInvoice[] {
  const sorted = [...invoices].sort((a, b) => a.date.localeCompare(b.date));
  let pool = receipts.reduce((sum, r) => sum + r.amount, 0);
  const asOfMs = Date.parse(asOfDate);

  const result: AgedInvoice[] = [];
  for (const inv of sorted) {
    const applied = Math.min(pool, inv.amount);
    pool -= applied;
    const outstanding = inv.amount - applied;
    if (outstanding <= 0) continue;
    const ageDays = Math.floor((asOfMs - Date.parse(inv.date)) / 86_400_000);
    result.push({ ...inv, outstanding, ageDays, bucket: bucketForAge(ageDays) });
  }
  return result;
}

export type AgingSummary = Record<AgingBucket, number> & { total: number };

export function summarizeAging(aged: AgedInvoice[]): AgingSummary {
  const sums: AgingSummary = { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };
  for (const inv of aged) {
    sums[inv.bucket] += inv.outstanding;
    sums.total += inv.outstanding;
  }
  return sums;
}
