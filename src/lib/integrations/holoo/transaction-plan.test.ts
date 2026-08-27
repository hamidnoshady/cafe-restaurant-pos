import { describe, expect, it } from "vitest";
import { findUnmappedReferences, importableTransactions, sortChronologically, type HolooTransaction } from "./transaction-plan";

const tx = (partial: Partial<HolooTransaction> & { remoteId: string }): HolooTransaction => ({
  type: "sale",
  occurredAt: "2024-01-01T00:00:00.000Z",
  ...partial,
});

describe("sortChronologically", () => {
  it("orders earlier first and is stable for ties", () => {
    const input = [
      tx({ remoteId: "b", occurredAt: "2024-01-02T00:00:00.000Z" }),
      tx({ remoteId: "a", occurredAt: "2024-01-01T00:00:00.000Z" }),
      tx({ remoteId: "c", occurredAt: "2024-01-02T00:00:00.000Z" }),
    ];
    expect(sortChronologically(input).map((t) => t.remoteId)).toEqual(["a", "b", "c"]);
  });
});

describe("findUnmappedReferences", () => {
  it("flags transactions referencing unmapped goods or persons", () => {
    const txs = [
      tx({ remoteId: "1", goodsId: "g-missing" }),
      tx({ remoteId: "2", personId: "p-missing", type: "receipt" }),
      tx({ remoteId: "3", goodsId: "g-ok", personId: "p-ok" }),
    ];
    const d = findUnmappedReferences(txs, new Set(["g-ok"]), new Set(["p-ok"]));
    expect(d.map((x) => x.remoteId)).toEqual(["1", "2"]);
    expect(d[0].missingGoods).toBe(true);
    expect(d[1].missingPerson).toBe(true);
  });

  it("ignores null references", () => {
    expect(findUnmappedReferences([tx({ remoteId: "1" })], new Set(), new Set())).toEqual([]);
  });
});

describe("importableTransactions", () => {
  it("orders and splits importable from discrepancies", () => {
    const txs = [
      tx({ remoteId: "2", occurredAt: "2024-01-02T00:00:00.000Z" }),
      tx({ remoteId: "1", occurredAt: "2024-01-01T00:00:00.000Z", goodsId: "missing" }),
    ];
    const { ordered, discrepancies } = importableTransactions(txs, new Set(), new Set());
    expect(ordered.map((t) => t.remoteId)).toEqual(["2"]);
    expect(discrepancies.map((d) => d.remoteId)).toEqual(["1"]);
  });
});
