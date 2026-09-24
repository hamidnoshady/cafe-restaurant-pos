/**
 * The contract between the CRM and Accounting.
 *
 * ## Why a contract and not just imports
 *
 * The CRM needs money figures on a customer's file: what they owe, what
 * they've spent, whether they're overdue. There are exactly two ways to get
 * them and only one is safe.
 *
 * The unsafe way is to write the SQL in the CRM. It is quicker, and it is how
 * two screens end up disagreeing about what a customer owes — because A/R
 * attribution is genuinely subtle (it spans orders, receipts, cheques and the
 * amendment bridge, and the join is not the obvious one) and any second
 * implementation will get some corner of it wrong. When the CRM says «۲٬۰۰۰٬۰۰۰
 * بدهکار» and the accounting ledger says something else, nobody can tell which
 * is lying, and the CRM's number is the one that is wrong.
 *
 * So this module is a **narrow, typed, read-only facade** over Accounting's own
 * services. It adds no arithmetic of its own: every number here is produced by
 * `ar-service` and passed through. What it adds is a *boundary* — one place
 * that names what the CRM is allowed to know about money, so the answer to
 * "where does this figure come from?" is always the same file.
 *
 * ## The rules
 *
 * 1. **Read-only.** Nothing here writes a journal line, an order, a receipt or
 *    an invoice. The CRM does not post. A deal reaching «برنده» is a forecast
 *    being resolved, not a sale being made — see `crm-deal-handoff.ts` for the
 *    explicit, human-initiated path from a won deal to a real sales document.
 * 2. **No re-derivation.** If a number can be obtained from an Accounting
 *    service, it is obtained from that service. New SQL against
 *    `journal_lines` does not belong in the CRM, and a lint-style test asserts
 *    the CRM libraries contain none.
 * 3. **Degrades honestly.** A business with no chart of accounts has no A/R
 *    account, and the correct answer is "not available", not zero. Zero reads
 *    as "they owe nothing", which is a different and much worse claim.
 */

import { AGING_BUCKET_LABELS, oldestOverdueBucket } from "./aging";
import { getArAging, getCustomerArBalance } from "./ar-service";

/**
 * What the CRM is allowed to know about one customer's finances.
 *
 * Deliberately small. The customer file shows a balance, an overdue figure and
 * a link into Accounting for anything more — it is not a second accounts
 * screen, and every field added here is a field that can drift.
 */
export interface CustomerFinancialSummary {
  /**
   * False when the business has no A/R account configured. The UI must say
   * «حساب‌داری راه‌اندازی نشده» rather than «۰ ریال»: zero is a claim about
   * the customer, and this is a fact about the system.
   */
  available: boolean;
  /** Positive means the customer owes the business. Integer Rial. */
  balanceRial: number;
  /** The portion past its due date, when aging is computable. */
  overdueRial: number;
  /** Oldest bucket with anything in it — «۹۰+ روز» is the collections signal. */
  oldestBucketLabel: string | null;
  /** Whether there is any open receivable at all. */
  hasOpenBalance: boolean;
}

const EMPTY_SUMMARY: CustomerFinancialSummary = {
  available: false,
  balanceRial: 0,
  overdueRial: 0,
  oldestBucketLabel: null,
  hasOpenBalance: false,
};

/**
 * One customer's financial position, as Accounting reports it.
 *
 * The balance comes from `getCustomerArBalance`, which attributes A/R across
 * orders, receipts and cheques and bridges closed-order amendments. That join
 * is the reason this function exists rather than a query in the CRM: it is not
 * the join anyone writes from memory.
 */
export async function customerFinancialSummary(
  businessId: string,
  customerId: string,
): Promise<CustomerFinancialSummary> {
  const balance = await getCustomerArBalance(businessId, customerId);
  if (!balance.hasLedger) return EMPTY_SUMMARY;

  // Aging is a whole-book report, so it is only worth asking for when the
  // customer actually owes something. A customer at zero cannot be overdue.
  let overdueRial = 0;
  let oldestBucketLabel: string | null = null;
  if (balance.balance > 0) {
    try {
      const aging = await getArAging(businessId);
      const row = aging.rows.find((candidate) => candidate.customerId === customerId);
      if (row) {
        // Anything past due. The current bucket is money owed but not late,
        // which is a normal state and must not be reported as a problem.
        overdueRial = Math.max(0, row.total - row.current);
        const bucket = oldestOverdueBucket(row);
        oldestBucketLabel = bucket ? AGING_BUCKET_LABELS[bucket] : null;
      }
    } catch {
      // Aging is enrichment. If it fails, the balance is still true and is
      // still worth showing — failing the whole summary would hide a correct
      // number because an optional one was unavailable.
      overdueRial = 0;
      oldestBucketLabel = null;
    }
  }

  return {
    available: true,
    balanceRial: balance.balance,
    overdueRial,
    oldestBucketLabel,
    hasOpenBalance: balance.balance > 0,
  };
}
