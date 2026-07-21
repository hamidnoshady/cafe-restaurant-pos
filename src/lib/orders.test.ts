import { describe, expect, it } from "vitest";
import { computeDiscountAmount, computeLineSubtotal, computeOrderTotals, formatQueueLabel } from "./orders";

describe("computeLineSubtotal", () => {
  it("multiplies (unit price + modifiers) by quantity", () => {
    expect(computeLineSubtotal({ unitPrice: 100_000, quantity: 2, modifierDeltas: [] })).toBe(200_000);
    expect(computeLineSubtotal({ unitPrice: 100_000, quantity: 2, modifierDeltas: [10_000, -5_000] })).toBe(
      210_000,
    );
  });
});

describe("computeDiscountAmount", () => {
  it("is zero with no discount type or zero subtotal", () => {
    expect(computeDiscountAmount(100_000, { type: null })).toBe(0);
    expect(computeDiscountAmount(0, { type: "percent", value: 10 })).toBe(0);
  });

  it("computes percent off, clamped to 0-100", () => {
    expect(computeDiscountAmount(200_000, { type: "percent", value: 10 })).toBe(20_000);
    expect(computeDiscountAmount(200_000, { type: "percent", value: 150 })).toBe(200_000);
    expect(computeDiscountAmount(200_000, { type: "percent", value: -10 })).toBe(0);
  });

  it("computes fixed amount off, clamped to subtotal", () => {
    expect(computeDiscountAmount(200_000, { type: "amount", value: 50_000 })).toBe(50_000);
    expect(computeDiscountAmount(200_000, { type: "amount", value: 999_999 })).toBe(200_000);
    expect(computeDiscountAmount(200_000, { type: "amount", value: -10 })).toBe(0);
  });
});

describe("computeOrderTotals", () => {
  it("single line, no discount, no tax", () => {
    const totals = computeOrderTotals(
      [{ unitPrice: 100_000, quantity: 1, modifierDeltas: [], taxRatePercent: 0 }],
      { type: null },
    );
    expect(totals).toMatchObject({ subtotal: 100_000, discount: 0, tax: 0, total: 100_000 });
  });

  it("single line with tax", () => {
    const totals = computeOrderTotals(
      [{ unitPrice: 100_000, quantity: 1, modifierDeltas: [], taxRatePercent: 10 }],
      { type: null },
    );
    expect(totals).toMatchObject({ subtotal: 100_000, discount: 0, tax: 10_000, total: 110_000 });
  });

  it("distributes a percent discount proportionally and taxes the post-discount base", () => {
    const totals = computeOrderTotals(
      [
        { unitPrice: 300_000, quantity: 1, modifierDeltas: [], taxRatePercent: 10 },
        { unitPrice: 100_000, quantity: 1, modifierDeltas: [], taxRatePercent: 0 },
      ],
      { type: "percent", value: 10 },
    );
    // subtotal 400,000; discount 40,000 (10%)
    expect(totals.subtotal).toBe(400_000);
    expect(totals.discount).toBe(40_000);
    // line 1: share 300k/400k = 75% -> discount 30,000; taxable 270,000; tax 27,000
    // line 2: remainder -> discount 10,000; taxable 90,000; tax 0
    expect(totals.lines[0]).toMatchObject({ lineDiscount: 30_000, lineTax: 27_000, lineTotal: 297_000 });
    expect(totals.lines[1]).toMatchObject({ lineDiscount: 10_000, lineTax: 0, lineTotal: 90_000 });
    expect(totals.tax).toBe(27_000);
    expect(totals.total).toBe(400_000 - 40_000 + 27_000);
  });

  it("line discounts always sum exactly to the order discount (rounding remainder on the last line)", () => {
    const totals = computeOrderTotals(
      [
        { unitPrice: 33_333, quantity: 1, modifierDeltas: [], taxRatePercent: 0 },
        { unitPrice: 33_333, quantity: 1, modifierDeltas: [], taxRatePercent: 0 },
        { unitPrice: 33_334, quantity: 1, modifierDeltas: [], taxRatePercent: 0 },
      ],
      { type: "percent", value: 10 },
    );
    const sumLineDiscounts = totals.lines.reduce((a, l) => a + l.lineDiscount, 0);
    expect(sumLineDiscounts).toBe(totals.discount);
  });

  it("clamps a fixed-amount discount larger than the subtotal", () => {
    const totals = computeOrderTotals(
      [{ unitPrice: 50_000, quantity: 1, modifierDeltas: [], taxRatePercent: 0 }],
      { type: "amount", value: 500_000 },
    );
    expect(totals.discount).toBe(50_000);
    expect(totals.total).toBe(0);
  });

  it("handles an empty cart", () => {
    const totals = computeOrderTotals([], { type: null });
    expect(totals).toMatchObject({ subtotal: 0, discount: 0, tax: 0, total: 0, lines: [] });
  });
});

describe("formatQueueLabel", () => {
  it("prefixes takeaway with T-, dine-in with #", () => {
    expect(formatQueueLabel("takeaway", 42)).toBe("T-42");
    expect(formatQueueLabel("dine_in", 7)).toBe("#7");
  });
});
