import { describe, expect, it } from "vitest";
import { canTransitionTable, evenSplit } from "./table-sessions";

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
