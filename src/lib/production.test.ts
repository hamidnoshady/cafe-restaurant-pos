import { describe, expect, it } from "vitest";
import { quantityText, rialText } from "./inventory-exact";
import {
  expectedMaterialCost,
  formulaWouldCycle,
  productionUnitCost,
  scaleConversionCost,
  scaleFormulaInputs,
  scaleOutputQuantity,
  totalProductionCost,
  yieldVariance,
} from "./production";

const q = quantityText;
const r = rialText;

describe("scaleFormulaInputs", () => {
  it("multiplies each per-batch quantity by the number of batches", () => {
    const scaled = scaleFormulaInputs(
      [
        { inventoryItemId: "b-flour", quantity: q("500") },
        { inventoryItemId: "a-sugar", quantity: q("300") },
      ],
      q("2"),
    );
    expect(scaled).toEqual([
      { inventoryItemId: "a-sugar", quantity: "600" },
      { inventoryItemId: "b-flour", quantity: "1000" },
    ]);
  });

  it("returns inputs in ascending item order so lock acquisition is deterministic", () => {
    // The service locks rows in the order this returns them. Every other exact
    // path (sale, purchase receipt, count, reversal) locks in item-id order
    // too, which is what stops a run deadlocking against a concurrent sale.
    const scaled = scaleFormulaInputs(
      [
        { inventoryItemId: "ccc", quantity: q("1") },
        { inventoryItemId: "aaa", quantity: q("1") },
        { inventoryItemId: "bbb", quantity: q("1") },
      ],
      q("1"),
    );
    expect(scaled.map((s) => s.inventoryItemId)).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("combines two lines naming the same item rather than emitting it twice", () => {
    const scaled = scaleFormulaInputs(
      [
        { inventoryItemId: "milk", quantity: q("200") },
        { inventoryItemId: "milk", quantity: q("50") },
      ],
      q("3"),
    );
    expect(scaled).toEqual([{ inventoryItemId: "milk", quantity: "750" }]);
  });

  it("keeps fractional batches exact rather than rounding through a double", () => {
    const scaled = scaleFormulaInputs([{ inventoryItemId: "cream", quantity: q("0.333") }], q("1.5"));
    expect(scaled[0].quantity).toBe("0.4995");
  });

  it("rounds a product that would carry more than nine decimals rather than failing", () => {
    // Both factors may carry 9 decimals, so the raw product carries 18 — more
    // than quantityText (or numeric(24,9)) accepts.
    const scaled = scaleFormulaInputs([{ inventoryItemId: "yeast", quantity: q("0.000000001") }], q("1.5"));
    expect(scaled[0].quantity).toBe("0.000000002");
  });

  it("rejects a zero or negative batch count", () => {
    expect(() => scaleFormulaInputs([{ inventoryItemId: "flour", quantity: q("1") }], q("0"))).toThrow(
      "invalid_quantity",
    );
  });
});

describe("scaleOutputQuantity", () => {
  it("multiplies the formula's per-batch yield by the batch count", () => {
    expect(scaleOutputQuantity(q("8"), q("2"))).toBe("16");
  });

  it("rounds past nine decimals rather than failing", () => {
    expect(scaleOutputQuantity(q("0.000000001"), q("2.5"))).toBe("0.000000003");
  });
});

describe("productionUnitCost", () => {
  it("spreads the batch cost over the actual yield", () => {
    // 2,200,000 rial of cake ÷ 16 slices
    expect(productionUnitCost(r("2200000"), q("16"))).toBe("137500");
  });

  it("charges more per unit when the batch yielded less than expected", () => {
    // Same cake, but one slice broke: 15 slices out of the same 2,200,000.
    expect(productionUnitCost(r("2200000"), q("15"))).toBe("146666.666666667");
  });

  it("keeps a non-terminating division at nine decimals rather than truncating to whole rial", () => {
    // avg_cost is numeric(24,9); losing the remainder here would understate
    // every slice's cost and quietly inflate the reported margin.
    expect(productionUnitCost(r("1000"), q("3"))).toBe("333.333333333");
  });

  it("rejects a zero yield instead of dividing by zero", () => {
    expect(() => productionUnitCost(r("1000"), q("0"))).toThrow("invalid_quantity");
  });
});

describe("totalProductionCost", () => {
  it("adds the conversion cost to the material cost", () => {
    expect(totalProductionCost(r("1800000"), r("400000"))).toBe("2200000");
  });

  it("is the material cost alone when nothing was absorbed", () => {
    expect(totalProductionCost(r("1800000"), r("0"))).toBe("1800000");
  });

  it("stays exact above Number.MAX_SAFE_INTEGER", () => {
    expect(totalProductionCost(r("9007199254740993"), r("2"))).toBe("9007199254740995");
  });
});

describe("scaleConversionCost", () => {
  it("multiplies the formula's per-batch default by the batch count", () => {
    expect(scaleConversionCost(r("200000"), q("2"))).toBe("400000");
  });

  it("rounds a fractional batch to whole rial", () => {
    // 200,000 × 1.5 = 300,000; 200,001 × 0.5 = 100,000.5 → 100,001
    expect(scaleConversionCost(r("200000"), q("1.5"))).toBe("300000");
    expect(scaleConversionCost(r("200001"), q("0.5"))).toBe("100001");
  });
});

describe("yieldVariance", () => {
  it("reports a short batch as a negative difference and percent", () => {
    const variance = yieldVariance(q("16"), q("15"));
    expect(variance.difference).toBe("-1");
    expect(variance.percent).toBe(-6.3);
  });

  it("reports an over-yield as positive", () => {
    const variance = yieldVariance(q("16"), q("18"));
    expect(variance.difference).toBe("2");
    expect(variance.percent).toBe(12.5);
  });

  it("is zero when the batch landed exactly on the formula", () => {
    expect(yieldVariance(q("16"), q("16"))).toMatchObject({ difference: "0", percent: 0 });
  });
});

describe("expectedMaterialCost", () => {
  it("prices each per-batch input at its running average cost", () => {
    const cost = expectedMaterialCost(
      [
        { inventoryItemId: "flour", quantity: q("500") },
        { inventoryItemId: "sugar", quantity: q("300") },
      ],
      new Map([
        ["flour", "1200"],
        ["sugar", "900"],
      ]),
    );
    // 500 × 1200 + 300 × 900 = 600,000 + 270,000
    expect(cost).toBe("870000");
  });

  it("skips an input nothing has been bought for rather than refusing an estimate", () => {
    // A brand-new item has avg_cost 0 and no purchase history; an owner
    // sketching a formula should still see what the priced inputs come to.
    const cost = expectedMaterialCost(
      [
        { inventoryItemId: "flour", quantity: q("500") },
        { inventoryItemId: "brand-new", quantity: q("10") },
      ],
      new Map([["flour", "1200"]]),
    );
    expect(cost).toBe("600000");
  });

  it("rounds the total once, at the end", () => {
    // 3 × 0.5 = 1.5 rial; rounding each line first would give 2.
    const cost = expectedMaterialCost(
      [
        { inventoryItemId: "a", quantity: q("1") },
        { inventoryItemId: "b", quantity: q("1") },
        { inventoryItemId: "c", quantity: q("1") },
      ],
      new Map([
        ["a", "0.5"],
        ["b", "0.5"],
        ["c", "0.5"],
      ]),
    );
    expect(cost).toBe("2");
  });

  it("is zero for a formula with no inputs yet", () => {
    expect(expectedMaterialCost([], new Map())).toBe("0");
  });
});

describe("formulaWouldCycle", () => {
  it("refuses a formula that lists its own output as an input", () => {
    expect(formulaWouldCycle("cake", ["flour", "cake"], new Map())).toBe(true);
  });

  it("allows genuine nesting — a sponge base inside a cake", () => {
    // sponge is made from flour and eggs; the cake is made from sponge and
    // cream. That is the point of the feature, not a cycle.
    const producedBy = new Map([["sponge", ["flour", "eggs"]]]);
    expect(formulaWouldCycle("cake", ["sponge", "cream"], producedBy)).toBe(false);
  });

  it("catches an indirect cycle through a nested formula", () => {
    // sponge ← cake, so making the cake out of the sponge closes the loop.
    const producedBy = new Map([["sponge", ["cake", "eggs"]]]);
    expect(formulaWouldCycle("cake", ["sponge", "cream"], producedBy)).toBe(true);
  });

  it("catches a cycle three formulas deep", () => {
    const producedBy = new Map([
      ["slice", ["cake"]],
      ["cake", ["sponge"]],
      ["sponge", ["flour"]],
    ]);
    expect(formulaWouldCycle("cake", ["slice"], producedBy)).toBe(true);
    expect(formulaWouldCycle("gateau", ["slice"], producedBy)).toBe(false);
  });

  it("terminates on a graph that already contains a cycle elsewhere", () => {
    // Defensive: the walk must not hang on pre-existing bad data while
    // checking an unrelated formula.
    const producedBy = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    expect(formulaWouldCycle("unrelated", ["a"], producedBy)).toBe(false);
  });
});
