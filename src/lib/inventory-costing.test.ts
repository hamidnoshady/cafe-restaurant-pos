import { describe, expect, it } from "vitest";
import {
  calculateNewAverageCost,
  fifoCostingStrategy,
  getCostingStrategy,
  isLotBased,
  lifoCostingStrategy,
  lotConsumptionOrderClause,
  weightedAverageCostingStrategy,
  type Lot,
} from "./inventory-costing";

// Shared scenario for both exit criteria: three lots of coffee beans (g),
// oldest first, at three different costs.
const lots: Lot[] = [
  { id: "lot-1", remainingQty: 500, unitCost: 100 }, // oldest
  { id: "lot-2", remainingQty: 500, unitCost: 120 },
  { id: "lot-3", remainingQty: 500, unitCost: 150 }, // newest
];

describe("fifoCostingStrategy.calculateCOGS", () => {
  it("consumes a single lot when it covers the full quantity", () => {
    const result = fifoCostingStrategy.calculateCOGS(lots, 300, 999);
    expect(result.lines).toEqual([{ lotId: "lot-1", quantity: 300, unitCost: 100, lineCost: 30_000 }]);
    expect(result.totalCost).toBe(30_000);
    expect(result.shortfall).toBe(0);
  });

  it("consumes the oldest lot first, spilling into the next lot(s) at their own cost", () => {
    // 500 from lot-1 @100 + 300 from lot-2 @120
    const result = fifoCostingStrategy.calculateCOGS(lots, 800, 999);
    expect(result.lines).toEqual([
      { lotId: "lot-1", quantity: 500, unitCost: 100, lineCost: 50_000 },
      { lotId: "lot-2", quantity: 300, unitCost: 120, lineCost: 36_000 },
    ]);
    expect(result.totalCost).toBe(86_000);
    expect(result.shortfall).toBe(0);
  });

  it("spans all lots in order when the quantity exceeds every lot combined but does not exhaust stock", () => {
    // 500 @100 + 500 @120 + 200 @150
    const result = fifoCostingStrategy.calculateCOGS(lots, 1_200, 999);
    expect(result.lines).toEqual([
      { lotId: "lot-1", quantity: 500, unitCost: 100, lineCost: 50_000 },
      { lotId: "lot-2", quantity: 500, unitCost: 120, lineCost: 60_000 },
      { lotId: "lot-3", quantity: 200, unitCost: 150, lineCost: 30_000 },
    ]);
    expect(result.totalCost).toBe(140_000);
    expect(result.shortfall).toBe(0);
  });

  it("skips exhausted lots (remainingQty 0)", () => {
    const withExhausted: Lot[] = [{ id: "lot-1", remainingQty: 0, unitCost: 100 }, ...lots.slice(1)];
    const result = fifoCostingStrategy.calculateCOGS(withExhausted, 300, 999);
    expect(result.lines).toEqual([{ lotId: "lot-2", quantity: 300, unitCost: 120, lineCost: 36_000 }]);
  });

  it("costs any shortfall beyond total lot stock at the last-consumed lot's cost", () => {
    // all 1500 in lots consumed (170_000) + 100 shortfall @150 (last lot's cost)
    const result = fifoCostingStrategy.calculateCOGS(lots, 1_600, 999);
    const shortfallLine = result.lines[result.lines.length - 1];
    expect(shortfallLine).toEqual({ lotId: null, quantity: 100, unitCost: 150, lineCost: 15_000 });
    expect(result.shortfall).toBe(100);
    expect(result.totalCost).toBe(50_000 + 60_000 + 75_000 + 15_000);
  });

  it("costs the entire quantity at the fallback cost when there are no lots at all", () => {
    const result = fifoCostingStrategy.calculateCOGS([], 200, 90);
    expect(result.lines).toEqual([{ lotId: null, quantity: 200, unitCost: 90, lineCost: 18_000 }]);
    expect(result.shortfall).toBe(200);
  });
});

describe("lifoCostingStrategy.calculateCOGS", () => {
  // LIFO consumes `lots` in the order given — the caller sorts them
  // newest-received-first (lotConsumptionOrderClause("lifo")).
  const newestFirst = [...lots].reverse();

  it("consumes the newest lot first, spilling into older lots at their own cost", () => {
    // 500 from lot-3 @150 + 300 from lot-2 @120
    const result = lifoCostingStrategy.calculateCOGS(newestFirst, 800, 999);
    expect(result.lines).toEqual([
      { lotId: "lot-3", quantity: 500, unitCost: 150, lineCost: 75_000 },
      { lotId: "lot-2", quantity: 300, unitCost: 120, lineCost: 36_000 },
    ]);
    expect(result.totalCost).toBe(111_000);
    expect(result.shortfall).toBe(0);
  });

  it("costs any shortfall beyond total lot stock at the last-consumed (oldest) lot's cost", () => {
    const result = lifoCostingStrategy.calculateCOGS(newestFirst, 1_600, 999);
    const shortfallLine = result.lines[result.lines.length - 1];
    expect(shortfallLine).toEqual({ lotId: null, quantity: 100, unitCost: 100, lineCost: 10_000 });
    expect(result.shortfall).toBe(100);
    expect(result.totalCost).toBe(75_000 + 60_000 + 50_000 + 10_000);
  });
});

describe("method helpers", () => {
  it("isLotBased: fifo and lifo keep lots, weighted average does not", () => {
    expect(isLotBased("fifo")).toBe(true);
    expect(isLotBased("lifo")).toBe(true);
    expect(isLotBased("weighted_average")).toBe(false);
  });

  it("lotConsumptionOrderClause: oldest-first for FIFO, newest-first for LIFO", () => {
    expect(lotConsumptionOrderClause("fifo")).toBe("received_at, id");
    expect(lotConsumptionOrderClause("weighted_average")).toBe("received_at, id");
    expect(lotConsumptionOrderClause("lifo")).toBe("received_at DESC, id DESC");
  });

  it("getCostingStrategy returns the matching strategy object", () => {
    expect(getCostingStrategy("fifo")).toBe(fifoCostingStrategy);
    expect(getCostingStrategy("lifo")).toBe(lifoCostingStrategy);
    expect(getCostingStrategy("weighted_average")).toBe(weightedAverageCostingStrategy);
  });
});

describe("weightedAverageCostingStrategy.calculateCOGS", () => {
  it("costs the full quantity at the given average cost, ignoring lots", () => {
    // Same 1_200g draw as the FIFO "spans all lots" case above, but priced
    // at the single blended average cost across the same 1500g of stock:
    // (500*100 + 500*120 + 500*150) / 1500 = 123.33.. -> rounds to 123
    const avgCost = 123;
    const result = weightedAverageCostingStrategy.calculateCOGS(lots, 1_200, avgCost);
    expect(result.lines).toEqual([{ lotId: null, quantity: 1_200, unitCost: 123, lineCost: 147_600 }]);
    expect(result.totalCost).toBe(147_600);
    expect(result.shortfall).toBe(0);
  });

  it("never reports a shortfall (weighted average has no lot stock to exhaust)", () => {
    const result = weightedAverageCostingStrategy.calculateCOGS([], 10_000, 50);
    expect(result.shortfall).toBe(0);
  });
});

describe("calculateNewAverageCost", () => {
  it("is the incoming unit cost when there's no prior stock", () => {
    expect(calculateNewAverageCost(0, 0, 500, 100)).toBe(100);
  });

  it("blends existing and incoming stock by value", () => {
    // 500 @100 existing + 500 @150 incoming -> (50_000 + 75_000) / 1000 = 125
    expect(calculateNewAverageCost(500, 100, 500, 150)).toBe(125);
  });

  it("matches the three-lot blended scenario used by the FIFO tests", () => {
    let avg = calculateNewAverageCost(0, 0, 500, 100);
    avg = calculateNewAverageCost(500, avg, 500, 120);
    avg = calculateNewAverageCost(1_000, avg, 500, 150);
    expect(avg).toBe(123); // matches the 123 used above
  });
});
