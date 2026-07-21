import { describe, expect, it } from "vitest";
import {
  computeIngredientRequirements,
  convertPurchaseQuantity,
  crossedLowStockThreshold,
  isLowStock,
  type ModifierRecipeLine,
  type RecipeLine,
} from "./inventory";

const MILK = "inv-milk";
const OAT_MILK = "inv-oat-milk";
const COFFEE = "inv-coffee";
const CUP = "inv-cup";

const recipes = new Map<string, RecipeLine[]>([
  ["latte", [{ inventoryItemId: MILK, quantity: 200 }, { inventoryItemId: COFFEE, quantity: 18 }, { inventoryItemId: CUP, quantity: 1 }]],
  ["espresso", [{ inventoryItemId: COFFEE, quantity: 9 }, { inventoryItemId: CUP, quantity: 1 }]],
]);

// oat milk swap: remove the dairy milk, add the same amount of oat milk
const modifierRecipes = new Map<string, ModifierRecipeLine[]>([
  ["oat-milk-swap", [{ inventoryItemId: MILK, quantityDelta: -200 }, { inventoryItemId: OAT_MILK, quantityDelta: 200 }]],
  ["extra-shot", [{ inventoryItemId: COFFEE, quantityDelta: 9 }]],
]);

describe("computeIngredientRequirements", () => {
  it("multiplies a single line's recipe by its quantity", () => {
    const result = computeIngredientRequirements(
      [{ menuItemId: "espresso", quantity: 3, modifierIds: [] }],
      recipes,
      modifierRecipes,
    );
    expect(result.get(COFFEE)).toBe(27);
    expect(result.get(CUP)).toBe(3);
  });

  it("sums the same ingredient across multiple lines", () => {
    const result = computeIngredientRequirements(
      [
        { menuItemId: "espresso", quantity: 2, modifierIds: [] },
        { menuItemId: "latte", quantity: 1, modifierIds: [] },
      ],
      recipes,
      modifierRecipes,
    );
    // coffee: 2*9 (espresso) + 18 (latte) = 36
    expect(result.get(COFFEE)).toBe(36);
    expect(result.get(CUP)).toBe(3);
    expect(result.get(MILK)).toBe(200);
  });

  it("applies a modifier's ingredient swap on top of the base recipe", () => {
    const result = computeIngredientRequirements(
      [{ menuItemId: "latte", quantity: 1, modifierIds: ["oat-milk-swap"] }],
      recipes,
      modifierRecipes,
    );
    expect(result.has(MILK)).toBe(false); // fully offset -> dropped
    expect(result.get(OAT_MILK)).toBe(200);
    expect(result.get(COFFEE)).toBe(18);
  });

  it("applies an additive modifier (extra shot) on top of the base recipe, scaled by quantity", () => {
    const result = computeIngredientRequirements(
      [{ menuItemId: "espresso", quantity: 2, modifierIds: ["extra-shot"] }],
      recipes,
      modifierRecipes,
    );
    // (9 base + 9 extra) * 2 lines = 36
    expect(result.get(COFFEE)).toBe(36);
  });

  it("ignores lines with no menu item or zero/negative quantity", () => {
    const result = computeIngredientRequirements(
      [
        { menuItemId: null, quantity: 2, modifierIds: [] },
        { menuItemId: "espresso", quantity: 0, modifierIds: [] },
      ],
      recipes,
      modifierRecipes,
    );
    expect(result.size).toBe(0);
  });

  it("drops an ingredient whose net requirement is zero or negative", () => {
    const overSwap = new Map<string, ModifierRecipeLine[]>([
      ["big-swap", [{ inventoryItemId: MILK, quantityDelta: -500 }, { inventoryItemId: OAT_MILK, quantityDelta: 200 }]],
    ]);
    const result = computeIngredientRequirements(
      [{ menuItemId: "latte", quantity: 1, modifierIds: ["big-swap"] }],
      recipes,
      overSwap,
    );
    expect(result.has(MILK)).toBe(false);
    expect(result.get(OAT_MILK)).toBe(200);
  });
});

describe("convertPurchaseQuantity", () => {
  it("multiplies purchase quantity by the item's purchase-unit factor", () => {
    expect(convertPurchaseQuantity(5, 1000)).toBe(5000); // 5 kg -> 5000 g
    expect(convertPurchaseQuantity(2, 1)).toBe(2); // no conversion
  });
});

describe("isLowStock", () => {
  it("is false when there's no reorder threshold set", () => {
    expect(isLowStock(0, null)).toBe(false);
  });

  it("is true once stock is at or below the threshold", () => {
    expect(isLowStock(10, 10)).toBe(true);
    expect(isLowStock(9, 10)).toBe(true);
    expect(isLowStock(11, 10)).toBe(false);
  });
});

describe("crossedLowStockThreshold", () => {
  it("is true only when stock moves from above to at-or-below the threshold", () => {
    expect(crossedLowStockThreshold(15, 8, 10)).toBe(true);
    expect(crossedLowStockThreshold(15, 10, 10)).toBe(true);
    expect(crossedLowStockThreshold(8, 5, 10)).toBe(false); // already low
    expect(crossedLowStockThreshold(15, 12, 10)).toBe(false); // still above
  });

  it("is false with no threshold set", () => {
    expect(crossedLowStockThreshold(15, 0, null)).toBe(false);
  });
});
