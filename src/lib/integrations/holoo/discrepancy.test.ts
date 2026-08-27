import { describe, expect, it } from "vitest";
import { entityDiscrepancies, trialBalanceDiscrepancies } from "./discrepancy";

describe("entityDiscrepancies", () => {
  it("names only the entity types that differ", () => {
    const diffs = entityDiscrepancies([
      { entityType: "goods", holooCount: 10, appCount: 10, holooBalanceRial: 100n, appBalanceRial: 100n },
      { entityType: "customers", holooCount: 5, appCount: 4, holooBalanceRial: 0n, appBalanceRial: 0n },
    ]);
    expect(diffs).toEqual([{ entityType: "customers", countDiff: -1, balanceDiffRial: 0n }]);
  });
});

describe("trialBalanceDiscrepancies", () => {
  it("flags account-by-account debit/credit differences", () => {
    const diffs = trialBalanceDiscrepancies([
      { code: "1100", holooDebitRial: 500n, holooCreditRial: 0n, appDebitRial: 500n, appCreditRial: 0n },
      { code: "2100", holooDebitRial: 0n, holooCreditRial: 100n, appDebitRial: 0n, appCreditRial: 90n },
    ]);
    expect(diffs).toEqual([{ code: "2100", debitDiffRial: 0n, creditDiffRial: -10n }]);
  });
});
