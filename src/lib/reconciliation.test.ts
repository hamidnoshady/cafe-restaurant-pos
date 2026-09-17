/**
 * The pure half of «تطبیق بانکی و صندوق».
 *
 * Every case here is one the screen or the service used to get wrong, so the
 * tests read as the list of bugs this module exists to prevent: an account key
 * mislabelled by a two-way ternary, a `date` column handed a non-date, a
 * `bigint` column handed a word, a cleared credit counted as money in, and a
 * statement dated before the last completed one.
 */
import { describe, expect, it } from "vitest";
import {
  filterReconciliationLines,
  isIsoDate,
  isJournalLineId,
  isReconcilableAccount,
  isStatementDateAfterLast,
  reconcilableAccountForCode,
  reconciliationBalances,
  reconciliationTotals,
  RECONCILABLE_ACCOUNT_CODES,
  RECONCILABLE_ACCOUNT_META,
  RECONCILABLE_ACCOUNTS,
  type ReconciliationLine,
} from "./reconciliation";

function line(over: Partial<ReconciliationLine> = {}): ReconciliationLine {
  return {
    journalLineId: "1",
    entryDate: "2025-04-10",
    memo: "فروش نقدی",
    sourceType: "order",
    debit: 100_000,
    credit: 0,
    cleared: false,
    ...over,
  };
}

describe("the reconcilable account set", () => {
  it("covers exactly صندوق، بانک and کارت‌خوان, each with its own ledger code", () => {
    expect(RECONCILABLE_ACCOUNTS).toEqual(["cash", "bank", "bankClearing"]);
    expect(RECONCILABLE_ACCOUNT_CODES).toEqual({ cash: "1100", bank: "1110", bankClearing: "1120" });
    const codes = Object.values(RECONCILABLE_ACCOUNT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("gives every account a Persian label, its code and a hint — no key ever reaches a reader", () => {
    for (const key of RECONCILABLE_ACCOUNTS) {
      const meta = RECONCILABLE_ACCOUNT_META[key];
      expect(meta.key).toBe(key);
      expect(meta.label.trim()).not.toBe("");
      expect(meta.hint.trim()).not.toBe("");
      expect(meta.code).toBe(RECONCILABLE_ACCOUNT_CODES[key]);
      // A label that is still the English key is the bug this table prevents.
      expect(meta.label).not.toBe(key);
    }
  });

  it("maps a ledger code back to its own account, and refuses one it does not own", () => {
    expect(reconcilableAccountForCode("1100")).toBe("cash");
    // The regression this replaced a ternary for: 1110 used to report as کارت‌خوان.
    expect(reconcilableAccountForCode("1110")).toBe("bank");
    expect(reconcilableAccountForCode("1120")).toBe("bankClearing");
    expect(reconcilableAccountForCode("4300")).toBeNull();
  });

  it("guards the query-string account against anything else", () => {
    expect(isReconcilableAccount("bank")).toBe(true);
    expect(isReconcilableAccount("Bank")).toBe(false);
    expect(isReconcilableAccount("accountsReceivable")).toBe(false);
    expect(isReconcilableAccount(null)).toBe(false);
    expect(isReconcilableAccount(undefined)).toBe(false);
  });
});

describe("isIsoDate", () => {
  it("accepts a real calendar day", () => {
    expect(isIsoDate("2025-04-30")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true); // a leap day
  });

  it("refuses the shapes that reached Postgres as a 500", () => {
    expect(isIsoDate("2025-13-01")).toBe(false);
    expect(isIsoDate("2025-02-30")).toBe(false);
    expect(isIsoDate("2023-02-29")).toBe(false); // not a leap year
    expect(isIsoDate("1404-05-31")).toBe(true); // well-formed; Jalali conversion is the caller's job
    expect(isIsoDate("۱۴۰۴-۰۵-۳۱")).toBe(false);
    expect(isIsoDate("2025-4-3")).toBe(false);
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(20250430)).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
});

describe("isJournalLineId", () => {
  it("accepts the decimal strings a bigint identity column produces", () => {
    expect(isJournalLineId("1")).toBe(true);
    expect(isJournalLineId("9007199254740993")).toBe(true);
  });

  it("refuses anything that would raise invalid input syntax for bigint", () => {
    expect(isJournalLineId("abc")).toBe(false);
    expect(isJournalLineId("1; DROP TABLE journal_lines")).toBe(false);
    expect(isJournalLineId("-1")).toBe(false);
    expect(isJournalLineId("1.5")).toBe(false);
    expect(isJournalLineId("")).toBe(false);
    expect(isJournalLineId(1)).toBe(false);
  });
});

describe("reconciliationTotals", () => {
  it("counts a cleared credit as money out, not money in", () => {
    const totals = reconciliationTotals([
      line({ journalLineId: "1", debit: 100_000, credit: 0, cleared: true }),
      line({ journalLineId: "2", debit: 0, credit: 30_000, cleared: true }),
    ]);
    expect(totals.clearedTotal).toBe(70_000);
    expect(totals.clearedCount).toBe(2);
    expect(totals.debitTotal).toBe(100_000);
    expect(totals.creditTotal).toBe(30_000);
  });

  it("keeps cleared and uncleared apart", () => {
    const totals = reconciliationTotals([
      line({ journalLineId: "1", debit: 50_000, cleared: true }),
      line({ journalLineId: "2", debit: 20_000, cleared: false }),
      line({ journalLineId: "3", debit: 0, credit: 5_000, cleared: false }),
    ]);
    expect(totals.clearedTotal).toBe(50_000);
    expect(totals.clearedCount).toBe(1);
    expect(totals.unclearedTotal).toBe(15_000);
    expect(totals.unclearedCount).toBe(2);
  });

  it("is all zeros for an empty account", () => {
    expect(reconciliationTotals([])).toEqual({
      clearedCount: 0,
      clearedTotal: 0,
      unclearedCount: 0,
      unclearedTotal: 0,
      debitTotal: 0,
      creditTotal: 0,
    });
  });
});

describe("reconciliationBalances", () => {
  it("adds the opening balance to the cleared total and reports the gap to the statement", () => {
    const balances = reconciliationBalances({
      openingBalance: 100_000,
      statementBalance: 140_000,
      lines: [line({ debit: 40_000, cleared: true })],
    });
    expect(balances.computedBalance).toBe(140_000);
    expect(balances.difference).toBe(0);
  });

  it("reports a positive difference when the statement holds more than the books have matched", () => {
    const balances = reconciliationBalances({
      openingBalance: 0,
      statementBalance: 100_000,
      lines: [line({ debit: 100_000, cleared: false })],
    });
    // Nothing ticked yet: the whole statement is still unaccounted for.
    expect(balances.clearedTotal).toBe(0);
    expect(balances.difference).toBe(100_000);
  });

  it("reports a negative difference when more has been ticked than the statement shows", () => {
    const balances = reconciliationBalances({
      openingBalance: 0,
      statementBalance: 60_000,
      lines: [line({ debit: 100_000, cleared: true })],
    });
    expect(balances.difference).toBe(-40_000);
  });

  it("carries a completed opening balance forward even with nothing left to tick", () => {
    const balances = reconciliationBalances({
      openingBalance: 250_000,
      statementBalance: 250_000,
      lines: [],
    });
    expect(balances.computedBalance).toBe(250_000);
    expect(balances.difference).toBe(0);
  });
});

describe("filterReconciliationLines", () => {
  const lines = [
    line({ journalLineId: "1", memo: "فروش نقدی", sourceType: "order", debit: 240_000, cleared: true }),
    line({ journalLineId: "2", memo: "پرداخت به تأمین‌کننده", sourceType: "ap_payment", debit: 0, credit: 80_000 }),
    line({ journalLineId: "3", memo: null, sourceType: "cheque", debit: 1_000_000 }),
  ];

  it("returns everything by default", () => {
    expect(filterReconciliationLines(lines)).toHaveLength(3);
  });

  it("splits cleared from uncleared — the filter a long list is unusable without", () => {
    expect(filterReconciliationLines(lines, { filter: "cleared" }).map((l) => l.journalLineId)).toEqual(["1"]);
    expect(filterReconciliationLines(lines, { filter: "uncleared" }).map((l) => l.journalLineId)).toEqual(["2", "3"]);
  });

  it("searches the description", () => {
    expect(filterReconciliationLines(lines, { query: "تأمین" }).map((l) => l.journalLineId)).toEqual(["2"]);
  });

  it("searches the amount as it is typed off a statement", () => {
    expect(filterReconciliationLines(lines, { query: "240000" }).map((l) => l.journalLineId)).toEqual(["1"]);
    expect(filterReconciliationLines(lines, { query: "80000" }).map((l) => l.journalLineId)).toEqual(["2"]);
  });

  it("searches the *Persian* source label, not only the English source code", () => {
    const sourceLabel = (s: string | null) => (s === "cheque" ? "چک" : "سند سیستمی");
    expect(
      filterReconciliationLines(lines, { query: "چک", sourceLabel }).map((l) => l.journalLineId),
    ).toEqual(["3"]);
  });

  it("combines a filter and a search", () => {
    expect(
      filterReconciliationLines(lines, { query: "فروش", filter: "uncleared" }),
    ).toHaveLength(0);
    expect(
      filterReconciliationLines(lines, { query: "فروش", filter: "cleared" }).map((l) => l.journalLineId),
    ).toEqual(["1"]);
  });

  it("ignores surrounding whitespace rather than returning nothing for a pasted value", () => {
    expect(filterReconciliationLines(lines, { query: "  فروش  " })).toHaveLength(1);
  });

  it("survives a line with no memo and no source", () => {
    const orphan = [line({ journalLineId: "9", memo: null, sourceType: null })];
    expect(filterReconciliationLines(orphan, { query: "چیزی" })).toHaveLength(0);
    expect(filterReconciliationLines(orphan, { query: "" })).toHaveLength(1);
  });
});

describe("isStatementDateAfterLast", () => {
  it("allows the first reconciliation of an account", () => {
    expect(isStatementDateAfterLast("2025-04-30", null)).toBe(true);
  });

  it("allows a later statement, and a second one for the same day", () => {
    expect(isStatementDateAfterLast("2025-05-31", "2025-04-30")).toBe(true);
    expect(isStatementDateAfterLast("2025-04-30", "2025-04-30")).toBe(true);
  });

  it("refuses one dated before the last completed reconciliation", () => {
    // Its opening balance would be a figure from its own future.
    expect(isStatementDateAfterLast("2025-03-31", "2025-04-30")).toBe(false);
  });
});
