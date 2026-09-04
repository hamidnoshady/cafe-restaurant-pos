import { describe, expect, it } from "vitest";
import { OUTBOX_MAX_ATTEMPTS } from "../integrations/retry";
import { afterFailure, planProductEvents, productInScope, sellableFromIngredients } from "./sync";

const both = { pushPrices: true, pushStock: true, productScope: "selected" as const };
const mapped = { remoteId: "r1", syncEnabled: true, lastPushedPriceRial: 100_000, lastPushedStock: 5 };

describe("Phase 38 Wave 3 — planProductEvents", () => {
  it("never sends an unmarked product, whatever changed", () => {
    const unmarked = { ...mapped, syncEnabled: false };
    expect(productInScope(unmarked, both)).toBe(false);
    expect(planProductEvents(unmarked, { priceRial: 999, stock: 0 }, both)).toEqual([]);
  });

  it("sends every mapped product when the scope is 'all'", () => {
    const unmarked = { ...mapped, syncEnabled: false };
    expect(planProductEvents(unmarked, { priceRial: 999, stock: 5 }, { ...both, productScope: "all" })).toEqual(["price.set"]);
  });

  it("upserts first when there is no remote id yet, and nothing else", () => {
    expect(planProductEvents({ ...mapped, remoteId: null }, { priceRial: 999, stock: 0 }, both)).toEqual(["product.upsert"]);
  });

  it("diffs price and stock against the last push, independently", () => {
    expect(planProductEvents(mapped, { priceRial: 100_000, stock: 5 }, both)).toEqual([]);
    expect(planProductEvents(mapped, { priceRial: 120_000, stock: 5 }, both)).toEqual(["price.set"]);
    expect(planProductEvents(mapped, { priceRial: 100_000, stock: 4 }, both)).toEqual(["stock.set"]);
    expect(planProductEvents(mapped, { priceRial: 120_000, stock: 4 }, both)).toEqual(["price.set", "stock.set"]);
  });

  it("honours the two switches separately", () => {
    const changed = { priceRial: 120_000, stock: 4 };
    expect(planProductEvents(mapped, changed, { ...both, pushPrices: false })).toEqual(["stock.set"]);
    expect(planProductEvents(mapped, changed, { ...both, pushStock: false })).toEqual(["price.set"]);
    expect(planProductEvents(mapped, changed, { ...both, pushPrices: false, pushStock: false })).toEqual([]);
  });

  it("does not queue a stock event when the app cannot say the stock", () => {
    expect(planProductEvents(mapped, { priceRial: 100_000, stock: null }, both)).toEqual([]);
  });
});

describe("Phase 38 Wave 3 — afterFailure", () => {
  it("backs off exponentially on a retryable failure", () => {
    const first = afterFailure(0, true);
    const second = afterFailure(1, true);
    expect(first).toMatchObject({ status: "failed", attempts: 1 });
    expect(second).toMatchObject({ status: "failed", attempts: 2 });
    expect(second.delayMs).toBeGreaterThan(first.delayMs);
  });

  it("dead-letters after the shared cap", () => {
    expect(afterFailure(OUTBOX_MAX_ATTEMPTS - 1, true)).toEqual({ status: "dead", attempts: OUTBOX_MAX_ATTEMPTS, delayMs: 0 });
  });

  it("dead-letters a non-retryable failure at once", () => {
    expect(afterFailure(0, false)).toEqual({ status: "dead", attempts: 1, delayMs: 0 });
  });
});

describe("sellableFromIngredients", () => {
  it("is the minimum over ingredients, floored, never negative, null with no recipe", () => {
    expect(sellableFromIngredients([])).toBeNull();
    expect(sellableFromIngredients([{ onHand: 10, perUnit: 3 }, { onHand: 100, perUnit: 2 }])).toBe(3);
    expect(sellableFromIngredients([{ onHand: -4, perUnit: 1 }])).toBe(0);
  });
});
