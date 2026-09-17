import { describe, expect, it } from "vitest";
import {
  canComplete,
  clearedTotalOf,
  computedBalanceOf,
  differenceOf,
  isLineWithinStatementWindow,
  isPlausibleStatementDate,
  isValidIsoDate,
  lineDelta,
  reconciliationTotals,
  STATEMENT_DATE_MAX_YEAR,
  STATEMENT_DATE_MIN_YEAR,
} from "./bank-reconciliation";

describe("lineDelta", () => {
  it("treats a debit as an increase and a credit as a decrease (every reconcilable account is an asset)", () => {
    expect(lineDelta({ debit: 100_000, credit: 0 })).toBe(100_000);
    expect(lineDelta({ debit: 0, credit: 100_000 })).toBe(-100_000);
  });
});

describe("clearedTotalOf", () => {
  it("counts only the ticked lines", () => {
    const lines = [
      { debit: 500_000, credit: 0, cleared: true },
      { debit: 300_000, credit: 0, cleared: false },
      { debit: 0, credit: 200_000, cleared: true },
    ];
    expect(clearedTotalOf(lines)).toBe(300_000);
  });

  it("is zero for no lines and for nothing ticked", () => {
    expect(clearedTotalOf([])).toBe(0);
    expect(clearedTotalOf([{ debit: 900, credit: 0, cleared: false }])).toBe(0);
  });
});

describe("computedBalanceOf / differenceOf", () => {
  it("adds the carried-forward opening balance to what this reconciliation clears", () => {
    expect(computedBalanceOf(100_000, 40_000)).toBe(140_000);
  });

  it("reports the difference as statement minus books, signed", () => {
    // The statement shows more than the books explain — a deposit not yet recorded.
    expect(differenceOf(140_000, 100_000)).toBe(40_000);
    // The books show more than the statement — a payment the bank hasn't applied.
    expect(differenceOf(100_000, 140_000)).toBe(-40_000);
    expect(differenceOf(140_000, 140_000)).toBe(0);
  });
});

describe("reconciliationTotals", () => {
  it("derives the whole header from the opening balance, the statement and the lines", () => {
    const totals = reconciliationTotals({
      openingBalance: 1_000_000,
      statementBalance: 1_250_000,
      lines: [
        { debit: 400_000, credit: 0, cleared: true },
        { debit: 0, credit: 150_000, cleared: true },
        { debit: 999_000, credit: 0, cleared: false },
      ],
    });
    expect(totals.clearedTotal).toBe(250_000);
    expect(totals.computedBalance).toBe(1_250_000);
    expect(totals.difference).toBe(0);
  });
});

describe("canComplete", () => {
  it("allows locking only an in-progress reconciliation that balances exactly", () => {
    expect(canComplete({ status: "in_progress", difference: 0 })).toBe(true);
    expect(canComplete({ status: "in_progress", difference: 1 })).toBe(false);
    expect(canComplete({ status: "in_progress", difference: -1 })).toBe(false);
    expect(canComplete({ status: "completed", difference: 0 })).toBe(false);
  });
});

describe("isValidIsoDate", () => {
  it("accepts a real Gregorian calendar date", () => {
    expect(isValidIsoDate("2025-06-30")).toBe(true);
    expect(isValidIsoDate("2024-02-29")).toBe(true); // leap year
  });

  it("rejects the inputs that used to reach the date column and 500", () => {
    expect(isValidIsoDate("not-a-date")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
    expect(isValidIsoDate("2025-6-3")).toBe(false);
    expect(isValidIsoDate("2025-13-01")).toBe(false);
    expect(isValidIsoDate("2025-02-30")).toBe(false);
    expect(isValidIsoDate("2023-02-29")).toBe(false); // not a leap year
    expect(isValidIsoDate(undefined)).toBe(false);
    expect(isValidIsoDate(20250630)).toBe(false);
  });
});

describe("isPlausibleStatementDate", () => {
  it("accepts ordinary statement dates, including catching up on an old period", () => {
    expect(isPlausibleStatementDate("2025-06-30")).toBe(true);
    expect(isPlausibleStatementDate(`${STATEMENT_DATE_MIN_YEAR}-01-01`)).toBe(true);
    expect(isPlausibleStatementDate(`${STATEMENT_DATE_MAX_YEAR}-12-31`)).toBe(true);
  });

  it("rejects a Jalali year typed into the Gregorian wire field", () => {
    // The screen sends ISO (JalaliDatePicker converts), so «۱۴۰۴/۰۴/۰۹» arriving
    // as 1404-04-09 means something bypassed that conversion: a reconciliation
    // six centuries back that could never match a posting.
    expect(isPlausibleStatementDate("1404-04-09")).toBe(false);
    expect(isPlausibleStatementDate("1403-12-29")).toBe(false);
  });

  it("rejects a typo'd century", () => {
    expect(isPlausibleStatementDate("0025-06-30")).toBe(false);
    expect(isPlausibleStatementDate("9999-06-30")).toBe(false);
  });
});

describe("isLineWithinStatementWindow", () => {
  it("includes lines up to and including the statement date", () => {
    expect(isLineWithinStatementWindow("2025-06-30", "2025-06-30")).toBe(true);
    expect(isLineWithinStatementWindow("2025-06-01", "2025-06-30")).toBe(true);
  });

  it("excludes a line posted after the statement date", () => {
    // The bug this guards: such a line could be *claimed* by a reconciliation
    // that then never displayed it, and no later reconciliation could see it.
    expect(isLineWithinStatementWindow("2025-07-02", "2025-06-30")).toBe(false);
  });
});
