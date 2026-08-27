/**
 * Phase 26 (issue #125) Wave 6 — the pure half of the migration discrepancy
 * report: compare Holoo against the app, per entity type (count and balance)
 * and per account (trial balance), and name every difference. Pure and
 * unit-tested; the DB half that gathers the two sides' numbers lives in
 * reconciliation-service.ts (Wave 9) and the wizard.
 */

export interface EntityComparison {
  entityType: string;
  holooCount: number;
  appCount: number;
  holooBalanceRial: bigint;
  appBalanceRial: bigint;
}

export interface EntityDiscrepancy {
  entityType: string;
  countDiff: number;
  balanceDiffRial: bigint;
}

/** Differences by entity type; a row with no difference is omitted. */
export function entityDiscrepancies(rows: readonly EntityComparison[]): EntityDiscrepancy[] {
  const out: EntityDiscrepancy[] = [];
  for (const row of rows) {
    const countDiff = row.appCount - row.holooCount;
    const balanceDiffRial = row.appBalanceRial - row.holooBalanceRial;
    if (countDiff !== 0 || balanceDiffRial !== 0n) {
      out.push({ entityType: row.entityType, countDiff, balanceDiffRial });
    }
  }
  return out;
}

export interface AccountBalance {
  code: string;
  holooDebitRial: bigint;
  holooCreditRial: bigint;
  appDebitRial: bigint;
  appCreditRial: bigint;
}

export interface AccountDiscrepancy {
  code: string;
  debitDiffRial: bigint;
  creditDiffRial: bigint;
}

/** Account-by-account trial-balance differences; a matching account is omitted. */
export function trialBalanceDiscrepancies(accounts: readonly AccountBalance[]): AccountDiscrepancy[] {
  const out: AccountDiscrepancy[] = [];
  for (const account of accounts) {
    const debitDiff = account.appDebitRial - account.holooDebitRial;
    const creditDiff = account.appCreditRial - account.holooCreditRial;
    if (debitDiff !== 0n || creditDiff !== 0n) {
      out.push({ code: account.code, debitDiffRial: debitDiff, creditDiffRial: creditDiff });
    }
  }
  return out;
}
