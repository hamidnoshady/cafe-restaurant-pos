/**
 * Phase 23 (issue #118) — Wave 5 reconciliation, the pure half.
 *
 * A reconciliation compares what the store says a period was worth with what
 * the local ledger recorded for the same period's imported orders. The only
 * arithmetic worth separating out (and unit-testing) is the difference and
 * the "in balance" judgement; the DB-touching half (reconciliation-service.ts)
 * gathers the two totals and stores the result.
 */

export interface ReconciliationTotals {
  remoteOrderCount: number;
  remoteTotalRial: bigint;
  localOrderCount: number;
  localTotalRial: bigint;
}

export interface ReconciliationResult extends ReconciliationTotals {
  /** remote − local; 0 means the books agree. */
  differenceRial: bigint;
  inBalance: boolean;
}

export function reconcileTotals(totals: ReconciliationTotals): ReconciliationResult {
  const differenceRial = totals.remoteTotalRial - totals.localTotalRial;
  return { ...totals, differenceRial, inBalance: differenceRial === 0n };
}
