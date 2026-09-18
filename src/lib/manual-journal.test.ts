import { describe, expect, it } from "vitest";
import {
  MANUAL_LINES_MAX,
  MANUAL_MEMO_MAX,
  manualDocumentProblem,
  manualJournalTotals,
  manualMemoProblem,
  nonZeroLines,
  type ManualJournalLine,
} from "./manual-journal";

/** Rent paid in cash — the two-line document the screen exists to write. */
function balanced(): ManualJournalLine[] {
  return [
    { accountId: "expense", debit: 100_000, credit: 0 },
    { accountId: "cash", debit: 0, credit: 100_000 },
  ];
}

describe("nonZeroLines", () => {
  it("drops the rows carrying no amount", () => {
    expect(
      nonZeroLines([...balanced(), { accountId: "bank", debit: 0, credit: 0 }]),
    ).toEqual(balanced());
  });
});

describe("manualJournalTotals", () => {
  it("sums each side and reports debit − credit", () => {
    expect(manualJournalTotals(balanced())).toEqual({
      totalDebit: 100_000n,
      totalCredit: 100_000n,
      difference: 0n,
    });
  });

  it("stays exact past Number.MAX_SAFE_INTEGER in aggregate", () => {
    // Ten rows just under the safe-integer ceiling: each is a legal amount,
    // their sum is not a safe Number. BigInt totals keep the comparison honest
    // instead of silently rounding two unequal sides into equality.
    const big = Number.MAX_SAFE_INTEGER - 1;
    const lines: ManualJournalLine[] = Array.from({ length: 10 }, (_, i) => ({
      accountId: `a${i}`,
      debit: big,
      credit: 0,
    }));
    expect(manualJournalTotals(lines).totalDebit).toBe(BigInt(big) * 10n);
  });
});

describe("manualDocumentProblem", () => {
  it("accepts a balanced two-account document", () => {
    expect(manualDocumentProblem(balanced())).toBeNull();
  });

  it("rejects a document with no amounts at all", () => {
    expect(manualDocumentProblem([{ accountId: "cash", debit: 0, credit: 0 }])).toBe("no_lines");
    expect(manualDocumentProblem([])).toBe("no_lines");
  });

  it("rejects a single row, which can never be a double entry", () => {
    expect(
      manualDocumentProblem([{ accountId: "cash", debit: 100_000, credit: 0 }]),
    ).toBe("too_few_lines");
  });

  it("rejects a balanced document that only touches one account", () => {
    // «صندوق بدهکار ۱۰٬۰۰۰ / صندوق بستانکار ۱۰٬۰۰۰» — arithmetically balanced,
    // financially meaningless, and permanent once posted. The screen used to
    // call this «متوازن».
    expect(
      manualDocumentProblem([
        { accountId: "cash", debit: 100_000, credit: 0 },
        { accountId: "cash", debit: 0, credit: 100_000 },
      ]),
    ).toBe("single_account_entry");
  });

  it("allows one account to repeat as long as two are named", () => {
    expect(
      manualDocumentProblem([
        { accountId: "expense", debit: 60_000, credit: 0 },
        { accountId: "expense", debit: 40_000, credit: 0 },
        { accountId: "cash", debit: 0, credit: 100_000 },
      ]),
    ).toBeNull();
  });

  it("rejects an unbalanced document", () => {
    expect(
      manualDocumentProblem([
        { accountId: "expense", debit: 100_000, credit: 0 },
        { accountId: "cash", debit: 0, credit: 90_000 },
      ]),
    ).toBe("not_balanced");
  });

  it("rejects a row that is both debit and credit, or has no account", () => {
    expect(
      manualDocumentProblem([
        { accountId: "expense", debit: 100_000, credit: 100_000 },
        { accountId: "cash", debit: 0, credit: 100_000 },
      ]),
    ).toBe("invalid_line");
    expect(
      manualDocumentProblem([
        { accountId: "", debit: 100_000, credit: 0 },
        { accountId: "cash", debit: 0, credit: 100_000 },
      ]),
    ).toBe("invalid_line");
  });

  it("rejects negative and fractional amounts", () => {
    expect(
      manualDocumentProblem([
        { accountId: "expense", debit: -100_000, credit: 0 },
        { accountId: "cash", debit: 0, credit: -100_000 },
      ]),
    ).toBe("invalid_line");
    expect(
      manualDocumentProblem([
        { accountId: "expense", debit: 100_000.5, credit: 0 },
        { accountId: "cash", debit: 0, credit: 100_000.5 },
      ]),
    ).toBe("invalid_line");
  });

  it("caps the number of rows in one document", () => {
    const rows = (n: number): ManualJournalLine[] => [
      ...Array.from({ length: n }, (_, i) => ({ accountId: `a${i}`, debit: 10, credit: 0 })),
      { accountId: "cash", debit: 0, credit: 10 * n },
    ];
    expect(manualDocumentProblem(rows(MANUAL_LINES_MAX - 1))).toBeNull();
    expect(manualDocumentProblem(rows(MANUAL_LINES_MAX))).toBe("too_many_lines");
  });

  it("checks the row shape before the balance, so a bad row is named as one", () => {
    // Both wrong at once: the actionable message is "fix this row", not
    // "the totals differ".
    expect(
      manualDocumentProblem([
        { accountId: "expense", debit: 1.5, credit: 0 },
        { accountId: "cash", debit: 0, credit: 999 },
      ]),
    ).toBe("invalid_line");
  });
});

describe("manualMemoProblem", () => {
  it("requires a memo that is more than whitespace", () => {
    expect(manualMemoProblem("")).toBe("memo_required");
    expect(manualMemoProblem("   ")).toBe("memo_required");
  });

  it("accepts a normal memo", () => {
    expect(manualMemoProblem("تسویه مالیات بر ارزش افزوده")).toBeNull();
  });

  it("caps the memo length, measuring the trimmed text", () => {
    expect(manualMemoProblem("x".repeat(MANUAL_MEMO_MAX))).toBeNull();
    expect(manualMemoProblem("x".repeat(MANUAL_MEMO_MAX + 1))).toBe("memo_too_long");
    // Trailing whitespace is trimmed before storage, so it must not push an
    // otherwise-legal memo over the cap.
    expect(manualMemoProblem(`${"x".repeat(MANUAL_MEMO_MAX)}    `)).toBeNull();
  });
});
