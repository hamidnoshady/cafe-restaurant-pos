/**
 * Phase 26 (issue #125) Wave 4 — the pure planning half of transaction import.
 *
 * Two load-bearing decisions live here, neither of which should be made by a
 * DB-touching loop:
 *  - **chronological ordering** — stock movements must replay in time order or
 *    FIFO/weighted-average cost layers come out wrong, and a sale must follow
 *    the receipts that funded its stock;
 *  - **unmapped-reference detection** — a transaction that points at a good or
 *    person Wave 3 did not map must be reported as a discrepancy, never
 *    silently dropped (a silently dropped sale is a missing revenue line, not
 *    a clean import).
 *
 * Pure, framework-free, unit-tested.
 */

export type HolooTransactionType =
  | "sale"
  | "sale_return"
  | "purchase"
  | "purchase_return"
  | "receipt"
  | "payment"
  | "stock";

export interface HolooTransaction {
  /** The Holoo document id (stable mapping key). */
  remoteId: string;
  type: HolooTransactionType;
  /** ISO datetime (Gregorian) — the replay order key. */
  occurredAt: string;
  /** Holoo goods id this transaction references, when it references one. */
  goodsId?: string | null;
  /** Holoo person id (customer for sale/receipt, supplier for purchase/payment). */
  personId?: string | null;
  amountRial?: bigint | null;
  quantity?: number | null;
}

/** Stable chronological order: earlier first, original order for ties. */
export function sortChronologically(transactions: readonly HolooTransaction[]): HolooTransaction[] {
  return transactions
    .map((tx, index) => ({ tx, index }))
    .sort((a, b) => {
      const byDate = a.tx.occurredAt.localeCompare(b.tx.occurredAt);
      if (byDate !== 0) return byDate;
      return a.index - b.index;
    })
    .map(({ tx }) => tx);
}

export interface TransactionDiscrepancy {
  remoteId: string;
  type: HolooTransactionType;
  missingGoods: boolean;
  missingPerson: boolean;
}

/**
 * Transactions whose good/person references have no Wave 3 mapping. These are
 * reported, not skipped — the caller decides how to surface them.
 */
export function findUnmappedReferences(
  transactions: readonly HolooTransaction[],
  mappedGoods: ReadonlySet<string>,
  mappedPersons: ReadonlySet<string>,
): TransactionDiscrepancy[] {
  const out: TransactionDiscrepancy[] = [];
  for (const tx of transactions) {
    const missingGoods = Boolean(tx.goodsId && !mappedGoods.has(tx.goodsId));
    const missingPerson = Boolean(tx.personId && !mappedPersons.has(tx.personId));
    if (missingGoods || missingPerson) {
      out.push({ remoteId: tx.remoteId, type: tx.type, missingGoods, missingPerson });
    }
  }
  return out;
}

/** The transactions that are safe to import: ordered, with no unmapped references. */
export function importableTransactions(
  transactions: readonly HolooTransaction[],
  mappedGoods: ReadonlySet<string>,
  mappedPersons: ReadonlySet<string>,
): { ordered: HolooTransaction[]; discrepancies: TransactionDiscrepancy[] } {
  const ordered = sortChronologically(transactions);
  const discrepancies = findUnmappedReferences(ordered, mappedGoods, mappedPersons);
  const badIds = new Set(discrepancies.map((d) => d.remoteId));
  return {
    ordered: ordered.filter((tx) => !badIds.has(tx.remoteId)),
    discrepancies,
  };
}
