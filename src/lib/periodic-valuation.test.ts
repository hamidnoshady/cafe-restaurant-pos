import { describe, expect, it } from "vitest";
import { periodicCogs, valueEndingInventory, type PeriodCostLayer } from "./periodic-valuation";

// Shared scenario: beginning inventory + two purchases, chronological order.
//   beginning: 10 units worth 1,000,000 (unit 100,000)
//   purchase1: 10 units worth 1,200,000 (unit 120,000)
//   purchase2: 10 units worth 1,500,000 (unit 150,000)
const layers: PeriodCostLayer[] = [
  { quantity: "10", valueRial: "1000000" },
  { quantity: "10", valueRial: "1200000" },
  { quantity: "10", valueRial: "1500000" },
];

describe("valueEndingInventory — weighted_average (میانگین موزون کلاسیک)", () => {
  it("prices the whole count at total value ÷ total quantity", () => {
    // pooled unit = 3,700,000 / 30 = 123,333.33…; count 12 → 1,480,000
    const result = valueEndingInventory(layers, "12", "weighted_average");
    expect(result.endingValueRial).toBe("1480000");
    expect(result.excessQty).toBe("0");
  });

  it("values a full count at exactly the total layer value", () => {
    const result = valueEndingInventory(layers, "30", "weighted_average");
    expect(result.endingValueRial).toBe("3700000");
  });

  it("reports the excess when the count exceeds all layers", () => {
    const result = valueEndingInventory(layers, "33", "weighted_average");
    expect(result.excessQty).toBe("3");
    // still priced at the pooled average: 33 × 123,333.33… = 4,070,000
    expect(result.endingValueRial).toBe("4070000");
  });

  it("zero count is zero value", () => {
    expect(valueEndingInventory(layers, "0", "weighted_average")).toEqual({
      endingValueRial: "0",
      excessQty: "0",
    });
  });
});

describe("valueEndingInventory — periodic FIFO (ending stock = newest layers)", () => {
  it("values a count within the newest layer at that layer's cost", () => {
    // 8 remaining = 8 of purchase2 @150,000 = 1,200,000
    const result = valueEndingInventory(layers, "8", "fifo");
    expect(result.endingValueRial).toBe("1200000");
  });

  it("spills into the next-newest layer", () => {
    // 12 remaining = 10 @150,000 + 2 @120,000 = 1,500,000 + 240,000
    const result = valueEndingInventory(layers, "12", "fifo");
    expect(result.endingValueRial).toBe("1740000");
  });

  it("prices excess above all layers at the oldest layer's unit cost", () => {
    // 32 = all 30 (3,700,000) + 2 @100,000 (beginning is the last walked)
    const result = valueEndingInventory(layers, "32", "fifo");
    expect(result.endingValueRial).toBe("3900000");
    expect(result.excessQty).toBe("2");
  });
});

describe("valueEndingInventory — periodic LIFO (ending stock = oldest layers)", () => {
  it("values a count within the oldest layer at that layer's cost", () => {
    // 8 remaining = 8 of beginning @100,000 = 800,000
    const result = valueEndingInventory(layers, "8", "lifo");
    expect(result.endingValueRial).toBe("800000");
  });

  it("spills into the next-oldest layer", () => {
    // 12 remaining = 10 @100,000 + 2 @120,000 = 1,000,000 + 240,000
    const result = valueEndingInventory(layers, "12", "lifo");
    expect(result.endingValueRial).toBe("1240000");
  });

  it("prices excess above all layers at the newest layer's unit cost", () => {
    // 31 = all 30 (3,700,000) + 1 @150,000
    const result = valueEndingInventory(layers, "31", "lifo");
    expect(result.endingValueRial).toBe("3850000");
    expect(result.excessQty).toBe("1");
  });
});

describe("valueEndingInventory — edge cases", () => {
  it("no layers at all: count is excess, value zero", () => {
    const result = valueEndingInventory([], "5", "fifo");
    expect(result.endingValueRial).toBe("0");
    expect(result.excessQty).toBe("5");
  });

  it("skips zero-quantity layers", () => {
    const withEmpty: PeriodCostLayer[] = [{ quantity: "0", valueRial: "0" }, ...layers];
    expect(valueEndingInventory(withEmpty, "8", "lifo").endingValueRial).toBe("800000");
  });

  it("fractional quantities round each layer's contribution half-up per layer", () => {
    // 2.5 of a 10-unit layer worth 1,000,001 → 250,000.25 → 250,000
    const result = valueEndingInventory([{ quantity: "10", valueRial: "1000001" }], "2.5", "fifo");
    expect(result.endingValueRial).toBe("250000");
  });

  it("rejects a negative count", () => {
    expect(() => valueEndingInventory(layers, "-1", "fifo")).toThrow("negative_counted_qty");
  });
});

describe("periodicCogs", () => {
  it("B + P − E", () => {
    expect(periodicCogs("1000000", "2700000", "1740000")).toBe("1960000");
  });
  it("negative when the count exceeds the books (surplus period)", () => {
    expect(periodicCogs("0", "100", "150")).toBe("-50");
  });
});
