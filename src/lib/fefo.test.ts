import { describe, expect, it } from "vitest";
import { allocateFefo, expiredBatches, isBatchExpired, sellableQuantity, type Batch } from "./fefo";

const B = (id: string, expiryDate: string | null, quantity: string): Batch => ({ id, expiryDate, quantity });

describe("isBatchExpired", () => {
  it("expires only after the expiry date has passed", () => {
    expect(isBatchExpired("2026-08-16", "2026-08-17")).toBe(true);
    expect(isBatchExpired("2026-08-16", "2026-08-16")).toBe(false); // sellable on the day
    expect(isBatchExpired("2026-08-16", "2026-08-15")).toBe(false);
    expect(isBatchExpired(null, "2026-08-16")).toBe(false);
  });
});

describe("allocateFefo", () => {
  it("consumes the earliest-expiring batch first, then the next", () => {
    const allocation = allocateFefo(
      [B("a", "2026-09-01", "3"), B("b", "2026-08-01", "4"), B("c", "2026-10-01", "10")],
      "5",
    );
    expect(allocation).toEqual([
      { batchId: "b", quantity: "4" },
      { batchId: "a", quantity: "1" },
    ]);
  });

  it("consumes partial batches", () => {
    const allocation = allocateFefo([B("a", "2026-08-01", "3"), B("b", "2026-09-01", "2")], "4");
    expect(allocation).toEqual([
      { batchId: "a", quantity: "3" },
      { batchId: "b", quantity: "1" },
    ]);
  });

  it("throws when the batches are short", () => {
    expect(() => allocateFefo([B("a", "2026-08-01", "2")], "3")).toThrow("quantity_underflow");
  });

  it("keeps stable order on equal expiry dates", () => {
    const allocation = allocateFefo([B("x", "2026-08-01", "1"), B("y", "2026-08-01", "2")], "2");
    expect(allocation).toEqual([
      { batchId: "x", quantity: "1" },
      { batchId: "y", quantity: "1" },
    ]);
  });

  it("consumes undated batches last", () => {
    const allocation = allocateFefo([B("no-date", null, "5"), B("dated", "2026-08-01", "2")], "4");
    expect(allocation).toEqual([
      { batchId: "dated", quantity: "2" },
      { batchId: "no-date", quantity: "2" },
    ]);
  });

  it("handles fractional quantities exactly", () => {
    const allocation = allocateFefo([B("a", "2026-08-01", "2.5"), B("b", "2026-09-01", "1")], "3.1");
    expect(allocation).toEqual([
      { batchId: "a", quantity: "2.5" },
      { batchId: "b", quantity: "0.6" },
    ]);
  });
});

describe("expiredBatches", () => {
  it("returns only batches whose expiry has passed", () => {
    const batches = [B("a", "2026-08-01", "1"), B("b", null, "2"), B("c", "2026-08-20", "3")];
    expect(expiredBatches(batches, "2026-08-16").map((b) => b.id)).toEqual(["a"]);
  });
});

describe("sellableQuantity", () => {
  it("sums only non-expired batches", () => {
    const batches = [B("a", "2026-08-01", "1.5"), B("b", "2026-09-01", "2"), B("c", null, "3")];
    expect(sellableQuantity(batches, "2026-08-16")).toBe("5");
  });
});
