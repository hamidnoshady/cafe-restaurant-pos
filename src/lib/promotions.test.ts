import { describe, expect, it } from "vitest";
import { computeOrderTotals } from "./orders";
import { evaluatePromotions, isPromotionActive, type Promotion, type PromotionItem } from "./promotions";

const AT = (iso: string, hhmm = "12:00") => new Date(`${iso}T${hhmm}:00`);

const item = (id: string, gross: number, quantity = 1, extra: Partial<PromotionItem> = {}): PromotionItem => ({
  id,
  gross,
  quantity,
  ...extra,
});

describe("isPromotionActive", () => {
  it("honours an inclusive date window across a date boundary", () => {
    const promo: Promotion = {
      id: "p",
      kind: "percent",
      value: 10,
      priority: 1,
      stacking: "exclusive",
      activeFrom: "2026-08-01",
      activeTo: "2026-08-10",
    };
    expect(isPromotionActive(promo, AT("2026-07-31", "23:59"))).toBe(false);
    expect(isPromotionActive(promo, AT("2026-08-01", "00:00"))).toBe(true);
    expect(isPromotionActive(promo, AT("2026-08-10", "23:59"))).toBe(true);
    expect(isPromotionActive(promo, AT("2026-08-11", "00:00"))).toBe(false);
  });

  it("honours a time-of-day window with an exclusive upper bound", () => {
    const promo: Promotion = {
      id: "p",
      kind: "percent",
      value: 10,
      priority: 1,
      stacking: "exclusive",
      timeFrom: "17:00",
      timeTo: "19:00",
    };
    expect(isPromotionActive(promo, AT("2026-08-16", "16:59"))).toBe(false);
    expect(isPromotionActive(promo, AT("2026-08-16", "17:00"))).toBe(true);
    expect(isPromotionActive(promo, AT("2026-08-16", "18:59"))).toBe(true);
    expect(isPromotionActive(promo, AT("2026-08-16", "19:00"))).toBe(false);
  });
});

describe("evaluatePromotions", () => {
  it("applies a percent discount only to matching lines", () => {
    const items = [item("a", 100_000), item("b", 50_000)];
    const result = evaluatePromotions(
      items,
      [{ id: "p", kind: "percent", value: 10, itemIds: ["a"], priority: 1, stacking: "exclusive" }],
      AT("2026-08-16"),
    );
    expect(result.lineDiscounts).toEqual([10_000, 0]);
    expect(result.totalDiscount).toBe(10_000);
  });

  it("clamps an amount discount to the line gross", () => {
    const items = [item("a", 5_000)];
    const result = evaluatePromotions(
      items,
      [{ id: "p", kind: "amount", value: 20_000, itemIds: ["a"], priority: 1, stacking: "stackable" }],
      AT("2026-08-16"),
    );
    expect(result.lineDiscounts).toEqual([5_000]);
  });

  it("fires a bundle price only when every member is present", () => {
    const bundle: Promotion = {
      id: "set",
      kind: "bundle_price",
      value: 80_000,
      itemIds: ["a", "b"],
      priority: 1,
      stacking: "exclusive",
    };
    expect(
      evaluatePromotions([item("a", 50_000), item("b", 50_000)], [bundle], AT("2026-08-16")).totalDiscount,
    ).toBe(20_000);
    // One member missing → no discount at all.
    expect(evaluatePromotions([item("a", 50_000)], [bundle], AT("2026-08-16")).totalDiscount).toBe(0);
  });

  it("fires buy-x-get-y (set price) at the quantity threshold and not below", () => {
    const promo: Promotion = {
      id: "three",
      kind: "buy_x_get_y",
      value: 100_000,
      minQuantity: 3,
      itemIds: ["a"],
      priority: 1,
      stacking: "exclusive",
    };
    // 3 × 50,000 = 150,000 → set price 100,000 → 50,000 off.
    expect(evaluatePromotions([item("a", 150_000, 3)], [promo], AT("2026-08-16")).totalDiscount).toBe(50_000);
    // 2 units → below threshold → nothing.
    expect(evaluatePromotions([item("a", 100_000, 2)], [promo], AT("2026-08-16")).totalDiscount).toBe(0);
  });

  it("resolves overlap by priority: the higher-priority exclusive promotion wins, and the test names why", () => {
    const items = [item("a", 100_000)];
    const winner: Promotion = {
      id: "high",
      kind: "percent",
      value: 20,
      itemIds: ["a"],
      priority: 10,
      stacking: "exclusive",
    };
    const loser: Promotion = {
      id: "low",
      kind: "percent",
      value: 50,
      itemIds: ["a"],
      priority: 1,
      stacking: "exclusive",
    };
    // Both match the line, but "high" claims it first (priority 10 > 1), so
    // "low" is skipped — 20% wins over 50% because it is higher priority.
    const result = evaluatePromotions(items, [loser, winner], AT("2026-08-16"));
    expect(result.lineDiscounts).toEqual([20_000]);
    expect(result.applied.map((a) => a.promotionId)).toEqual(["high"]);
  });

  it("a lower-priority stackable promotion is blocked by a higher-priority exclusive one", () => {
    const items = [item("a", 100_000)];
    const result = evaluatePromotions(
      items,
      [
        { id: "exclusive", kind: "percent", value: 60, itemIds: ["a"], priority: 10, stacking: "exclusive" },
        { id: "stackable", kind: "percent", value: 50, itemIds: ["a"], priority: 1, stacking: "stackable" },
      ],
      AT("2026-08-16"),
    );
    // The exclusive promotion claims the line, so the stackable one never runs.
    expect(result.lineDiscounts).toEqual([60_000]);
  });

  it("a stackable promotion does not claim its lines, so a later exclusive one still applies", () => {
    const items = [item("a", 100_000)];
    const result = evaluatePromotions(
      items,
      [
        { id: "stackable", kind: "percent", value: 20, itemIds: ["a"], priority: 10, stacking: "stackable" },
        { id: "exclusive", kind: "percent", value: 50, itemIds: ["a"], priority: 1, stacking: "exclusive" },
      ],
      AT("2026-08-16"),
    );
    // Non-compounding: 20% of gross then 50% of gross, clamped to the line.
    expect(result.lineDiscounts).toEqual([70_000]);
  });

  it("produces byte-identical discounts through the F&B path and the retail path", () => {
    const promo: Promotion = {
      id: "three",
      kind: "buy_x_get_y",
      value: 100_000,
      minQuantity: 3,
      itemIds: ["a"],
      priority: 1,
      stacking: "exclusive",
    };

    // The retail path: the engine directly over the same cart shape a retail
    // invoice builds (one fungible line, 3 × 50,000).
    const retail = evaluatePromotions([item("a", 150_000, 3)], [promo], AT("2026-08-16"));

    // The F&B path: computeOrderTotals maps its CartLine onto the same engine.
    const fnb = computeOrderTotals(
      [{ id: "a", unitPrice: 50_000, quantity: 3, modifierDeltas: [], taxRatePercent: 0 }],
      { type: null },
      0,
      [promo],
      AT("2026-08-16"),
    );

    expect(fnb.discount).toBe(retail.totalDiscount);
    expect(fnb.discount).toBe(50_000);
  });

  it("keeps an inactive promotion inert even though it matches the cart", () => {
    const items = [item("a", 100_000)];
    const expired: Promotion = {
      id: "expired",
      kind: "percent",
      value: 20,
      itemIds: ["a"],
      priority: 10,
      stacking: "exclusive",
      activeTo: "2026-08-15",
    };
    expect(evaluatePromotions(items, [expired], AT("2026-08-16")).totalDiscount).toBe(0);
  });
});
