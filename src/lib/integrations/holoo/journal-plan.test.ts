import { describe, expect, it } from "vitest";
import { normalizeLine, normalizeVoucher, planJournalImport, type HolooVoucher } from "./journal-plan";

describe("normalizeLine", () => {
  it("nets a two-sided line to a single side", () => {
    expect(normalizeLine({ accountCode: "1100", debitRial: 100n, creditRial: 30n })).toEqual({
      accountCode: "1100",
      debit: 70,
      credit: 0,
    });
    expect(normalizeLine({ accountCode: "2100", debitRial: 30n, creditRial: 100n })).toEqual({
      accountCode: "2100",
      debit: 0,
      credit: 70,
    });
  });
});

describe("normalizeVoucher", () => {
  it("flags a balanced voucher", () => {
    const v: HolooVoucher = {
      remoteId: "1",
      entryDate: "2024-01-01",
      lines: [
        { accountCode: "1100", debitRial: 100n },
        { accountCode: "2100", creditRial: 100n },
      ],
    };
    const n = normalizeVoucher(v);
    expect(n.balanced).toBe(true);
    expect(n.difference).toBe(0);
  });

  it("flags an unbalanced voucher with the difference", () => {
    const v: HolooVoucher = {
      remoteId: "2",
      entryDate: "2024-01-01",
      lines: [
        { accountCode: "1100", debitRial: 100n },
        { accountCode: "2100", creditRial: 90n },
      ],
    };
    const n = normalizeVoucher(v);
    expect(n.balanced).toBe(false);
    expect(n.difference).toBe(10);
  });
});

describe("planJournalImport", () => {
  it("splits balanced from unbalanced — the unbalanced is a discrepancy, never auto-offset", () => {
    const plan = planJournalImport([
      { remoteId: "ok", entryDate: "2024-01-01", lines: [{ accountCode: "1100", debitRial: 50n }, { accountCode: "2100", creditRial: 50n }] },
      { remoteId: "bad", entryDate: "2024-01-02", lines: [{ accountCode: "1100", debitRial: 50n }] },
    ]);
    expect(plan.balanced.map((v) => v.remoteId)).toEqual(["ok"]);
    expect(plan.unbalanced.map((v) => v.remoteId)).toEqual(["bad"]);
  });
});
