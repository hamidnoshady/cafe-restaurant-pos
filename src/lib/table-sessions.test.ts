import { describe, expect, it } from "vitest";
import { canTransitionTable, evenSplit, itemizedSplit, type SplitLine } from "./table-sessions";

describe("canTransitionTable", () => {
  it("allows the core lifecycle path", () => {
    expect(canTransitionTable("free", "seated")).toBe(true);
    expect(canTransitionTable("seated", "bill_requested")).toBe(true);
    expect(canTransitionTable("bill_requested", "cleaning")).toBe(true);
    expect(canTransitionTable("cleaning", "free")).toBe(true);
  });

  it("allows the maintenance side-track and clearing a table directly", () => {
    expect(canTransitionTable("free", "out_of_service")).toBe(true);
    expect(canTransitionTable("out_of_service", "free")).toBe(true);
    expect(canTransitionTable("seated", "free")).toBe(true);
  });

  it("rejects impossible jumps", () => {
    expect(canTransitionTable("free", "cleaning")).toBe(false);
    expect(canTransitionTable("free", "bill_requested")).toBe(false);
    expect(canTransitionTable("cleaning", "seated")).toBe(false);
    expect(canTransitionTable("out_of_service", "seated")).toBe(false);
  });
});

describe("evenSplit", () => {
  it("splits a divisible total evenly", () => {
    expect(evenSplit(300_000, 3)).toEqual([100_000, 100_000, 100_000]);
  });

  it("hands the remainder to the earliest payers, differing by at most 1 rial", () => {
    const shares = evenSplit(100, 3);
    expect(shares).toEqual([34, 33, 33]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("always sums exactly to the total across many guest counts", () => {
    for (const total of [0, 1, 7, 999_999, 1_234_567]) {
      for (const n of [1, 2, 3, 4, 5, 7, 10]) {
        const shares = evenSplit(total, n);
        expect(shares).toHaveLength(n);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it("rejects a non-positive guest count", () => {
    expect(() => evenSplit(100, 0)).toThrow();
    expect(() => evenSplit(100, -2)).toThrow();
  });
});

describe("itemizedSplit", () => {
  it("charges each line to its assigned payer", () => {
    const lines: SplitLine[] = [
      { amount: 120_000, guest: 0 },
      { amount: 80_000, guest: 1 },
      { amount: 50_000, guest: 0 },
    ];
    expect(itemizedSplit(lines, 2)).toEqual([170_000, 80_000]);
  });

  it("splits shared (guest = null) lines evenly across all payers", () => {
    const lines: SplitLine[] = [
      { amount: 90_000, guest: 0 },
      { amount: 100, guest: null }, // shared → 34/33/33
    ];
    const totals = itemizedSplit(lines, 3);
    expect(totals).toEqual([90_034, 33, 33]);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(90_100);
  });

  it("sums exactly to the sum of all lines", () => {
    const lines: SplitLine[] = [
      { amount: 33_333, guest: 0 },
      { amount: 33_333, guest: 1 },
      { amount: 33_334, guest: null },
      { amount: 10_000, guest: 2 },
    ];
    const totals = itemizedSplit(lines, 3);
    const billTotal = lines.reduce((a, l) => a + l.amount, 0);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(billTotal);
  });

  it("rejects a line assigned to an out-of-range payer", () => {
    expect(() => itemizedSplit([{ amount: 1, guest: 5 }], 2)).toThrow();
  });
});
