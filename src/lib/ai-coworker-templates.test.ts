import { describe, expect, it } from "vitest";
import {
  buildCoworkerActions,
  COWORKER_TEMPLATE_LIST,
  COWORKER_TEMPLATES,
  validateTemplateParams,
  type CoworkerFacts,
} from "./ai-coworker-templates";
import type { AccountingFinding } from "./accounting-review";

const bread = {
  id: "item-bread",
  name: "نان",
  unit: "عدد",
  onHandQty: "12",
  unitCostRial: 50_000,
};

const facts: CoworkerFacts = { onHand: { [bread.id]: bread } };

describe("the template catalogue", () => {
  it("declares a module, a scope and at least one trigger for every template", () => {
    for (const template of COWORKER_TEMPLATE_LIST) {
      expect(template.module.length, template.key).toBeGreaterThan(0);
      expect(template.triggers.length, template.key).toBeGreaterThan(0);
      expect(template.triggers, template.key).toContain(template.suggestedTrigger);
      expect(["location", "business"], template.key).toContain(template.scope);
    }
  });

  it("only emits actions that exist in the catalogue", async () => {
    const { ACTION_CATALOG } = await import("./ai");
    for (const template of COWORKER_TEMPLATE_LIST) {
      for (const type of template.emits) expect(ACTION_CATALOG[type], type).toBeDefined();
    }
  });
});

describe("shift_close_waste — the bread at the end of the night", () => {
  const params = {
    items: [{ inventoryItemId: bread.id, mode: "remaining", reason: "spoilage" }],
  };

  it("writes off what is on the shelf NOW, not a number stored months ago", () => {
    const result = buildCoworkerActions("shift_close_waste", params, facts);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].payload).toMatchObject({
      inventoryItemId: bread.id,
      quantity: "12",
      reason: "spoilage",
    });

    // Same job, a slower night: the action follows the stock, with no edit.
    const busier = buildCoworkerActions("shift_close_waste", params, {
      onHand: { [bread.id]: { ...bread, onHandQty: "3" } },
    });
    expect(busier.actions[0].payload.quantity).toBe("3");
  });

  it("never writes off more than exists — that would open a layer at a price nobody paid", () => {
    const result = buildCoworkerActions(
      "shift_close_waste",
      { items: [{ inventoryItemId: bread.id, mode: "fixed", quantity: "40", reason: "spoilage" }] },
      facts,
    );
    expect(result.actions[0].payload.quantity).toBe("12");
  });

  it("keeps a fixed quantity that fits", () => {
    const result = buildCoworkerActions(
      "shift_close_waste",
      { items: [{ inventoryItemId: bread.id, mode: "fixed", quantity: "4.5", reason: "staff_meal" }] },
      facts,
    );
    expect(result.actions[0].payload).toMatchObject({ quantity: "4.5", reason: "staff_meal" });
  });

  it("does nothing, and says why, on a night that sold out", () => {
    const result = buildCoworkerActions("shift_close_waste", params, {
      onHand: { [bread.id]: { ...bread, onHandQty: "0" } },
    });
    expect(result.actions).toEqual([]);
    expect(result.skipReason).toBeTruthy();
  });

  it("skips an item that is no longer in this branch rather than inventing one", () => {
    const result = buildCoworkerActions("shift_close_waste", params, { onHand: {} });
    expect(result.actions).toEqual([]);
  });

  it("is deterministic — the same facts give the identical actions", () => {
    const a = buildCoworkerActions("shift_close_waste", params, facts);
    const b = buildCoworkerActions("shift_close_waste", params, facts);
    expect(a).toEqual(b);
  });

  it("validates its parameters", () => {
    expect(validateTemplateParams("shift_close_waste", params)).toEqual([]);
    expect(validateTemplateParams("shift_close_waste", {})).toEqual(["coworker_params_items_required"]);
    expect(
      validateTemplateParams("shift_close_waste", {
        items: [{ inventoryItemId: bread.id, mode: "fixed", reason: "spoilage" }],
      }),
    ).toContain("coworker_params_quantity_invalid");
    expect(
      validateTemplateParams("shift_close_waste", {
        items: [{ inventoryItemId: bread.id, mode: "remaining", reason: "because" }],
      }),
    ).toContain("coworker_params_reason_invalid");
  });
});

describe("shift_open_production — the morning bake", () => {
  const formulas = {
    "f-1": {
      id: "f-1",
      name: "خمیر نان",
      outputItemName: "نان",
      isActive: true,
      batchCostRial: 400_000,
    },
  };

  it("proposes one run per formula line", () => {
    const result = buildCoworkerActions("shift_open_production", { runs: [{ formulaId: "f-1", batches: "2" }] }, { formulas });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].payload).toMatchObject({ formulaId: "f-1", batches: "2" });
  });

  it("skips an inactive formula instead of guessing — the service would refuse it anyway", () => {
    const result = buildCoworkerActions(
      "shift_open_production",
      { runs: [{ formulaId: "f-1", batches: "2" }] },
      { formulas: { "f-1": { ...formulas["f-1"], isActive: false } } },
    );
    expect(result.actions).toEqual([]);
    expect(result.skipReason).toBeTruthy();
  });
});

describe("shift_open_stock_topup — the daily delivery", () => {
  it("drafts one purchase carrying every line", () => {
    const result = buildCoworkerActions(
      "shift_open_stock_topup",
      { lines: [{ inventoryItemId: bread.id, purchaseQty: "40", totalCostRial: 2_000_000 }] },
      facts,
    );
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe("inventory.reorder.draftPO");
    expect(result.actions[0].payload.items).toEqual([
      { inventoryItemId: bread.id, purchaseQty: "40", totalCost: "2000000" },
    ]);
  });

  it("rejects a non-integer Rial cost at validation rather than posting one", () => {
    expect(
      validateTemplateParams("shift_open_stock_topup", {
        lines: [{ inventoryItemId: bread.id, purchaseQty: "40", totalCostRial: 12.5 }],
      }),
    ).toContain("coworker_params_cost_invalid");
  });
});

describe("low_stock_purchase_draft", () => {
  const low = (supplierId: string | null, id: string) => ({
    id,
    name: `کالا ${id}`,
    unit: "kg",
    onHandQty: "1",
    reorderLevel: "5",
    suggestedPurchaseQty: "9",
    suggestedTotalCostRial: 900_000,
    supplierId,
  });

  it("splits by supplier — one purchase document cannot belong to two of them", () => {
    const result = buildCoworkerActions("low_stock_purchase_draft", {}, {
      lowStock: [low("s-1", "a"), low("s-2", "b"), low("s-1", "c")],
    });
    expect(result.actions).toHaveLength(2);
    const supplierIds = result.actions.map((action) => action.payload.supplierId).sort();
    expect(supplierIds).toEqual(["s-1", "s-2"]);
  });

  it("omits the supplier entirely for items that have none", () => {
    const result = buildCoworkerActions("low_stock_purchase_draft", {}, { lowStock: [low(null, "a")] });
    expect(result.actions[0].payload).not.toHaveProperty("supplierId");
  });

  it("does nothing when nothing is short", () => {
    const result = buildCoworkerActions("low_stock_purchase_draft", {}, { lowStock: [] });
    expect(result.actions).toEqual([]);
    expect(result.skipReason).toBeTruthy();
  });
});

describe("accounting_review", () => {
  const finding = (severity: AccountingFinding["severity"], code: string): AccountingFinding => ({
    code,
    severity,
    title: code,
    detail: "",
    count: 1,
    amountRial: null,
    suggestion: "",
    href: null,
    samples: [],
  });

  it("reports and never writes — a review that posts corrections is not a review", () => {
    const result = buildCoworkerActions("accounting_review", {}, {
      review: [finding("high", "unbalanced_entry")],
    });
    expect(result.actions).toEqual([]);
    expect(result.report?.findings).toHaveLength(1);
    expect(COWORKER_TEMPLATES.accounting_review.emits).toEqual([]);
  });

  it("honours the owner's severity floor, defaulting to 'medium'", () => {
    const review = [finding("high", "a"), finding("medium", "b"), finding("low", "c")];
    expect(buildCoworkerActions("accounting_review", {}, { review }).report?.findings).toHaveLength(2);
    expect(
      buildCoworkerActions("accounting_review", { minSeverity: "low" }, { review }).report?.findings,
    ).toHaveLength(3);
    expect(
      buildCoworkerActions("accounting_review", { minSeverity: "high" }, { review }).report?.findings,
    ).toHaveLength(1);
  });

  it("says so plainly when the books are clean", () => {
    const result = buildCoworkerActions("accounting_review", {}, { review: [] });
    expect(result.report).toBeUndefined();
    expect(result.skipReason).toBeTruthy();
  });
});
