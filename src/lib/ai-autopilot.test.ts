import { describe, expect, it } from "vitest";
import { ACTION_CATALOG } from "./ai";
import {
  AUTOPILOT_CEILINGS,
  AUTOPILOT_DEFAULTS,
  actionTypesForCategory,
  clampAutopilotSetting,
  evaluateAutopilotProposal,
  type AutopilotCategorySetting,
} from "./ai-autopilot";

const pricing: AutopilotCategorySetting = {
  enabled: true,
  maxAmountRial: 1_000_000,
  maxPercent: 10,
  maxItemsPerRun: 3,
  dailyActionLimit: 3,
};
const money: AutopilotCategorySetting = {
  enabled: true,
  maxAmountRial: 5_000_000,
  maxPercent: 10,
  maxItemsPerRun: 5,
  dailyActionLimit: 2,
};
const inventory: AutopilotCategorySetting = {
  enabled: true,
  maxAmountRial: 10_000_000,
  maxPercent: null,
  maxItemsPerRun: 5,
  dailyActionLimit: 2,
};
const customer: AutopilotCategorySetting = {
  enabled: true,
  maxAmountRial: null,
  maxPercent: null,
  maxItemsPerRun: 5,
  dailyActionLimit: 10,
};

function evaluate(
  type: keyof typeof ACTION_CATALOG,
  payload: Record<string, unknown>,
  setting: AutopilotCategorySetting,
  context: Parameters<typeof evaluateAutopilotProposal>[0]["context"] = {},
  appliedTodayInCategory = 0,
) {
  return evaluateAutopilotProposal({
    meta: ACTION_CATALOG[type],
    payload,
    setting,
    appliedTodayInCategory,
    context,
  });
}

describe("clampAutopilotSetting", () => {
  it("clamps every over-ceiling field down to the ceiling", () => {
    const clamped = clampAutopilotSetting("pricing", {
      enabled: true,
      maxAmountRial: 999_000_000,
      maxPercent: 90,
      maxItemsPerRun: 500,
      dailyActionLimit: 500,
    });
    expect(clamped.maxAmountRial).toBe(AUTOPILOT_CEILINGS.pricing.maxAmountRial);
    expect(clamped.maxPercent).toBe(AUTOPILOT_CEILINGS.pricing.maxPercent);
    expect(clamped.maxItemsPerRun).toBe(AUTOPILOT_CEILINGS.pricing.maxItemsPerRun);
    expect(clamped.dailyActionLimit).toBe(AUTOPILOT_CEILINGS.pricing.dailyActionLimit);
  });

  it("leaves under-ceiling values untouched and is idempotent", () => {
    const once = clampAutopilotSetting("money", { enabled: true, maxAmountRial: 1_000_000, maxPercent: 5 });
    expect(once.maxAmountRial).toBe(1_000_000);
    expect(once.maxPercent).toBe(5);
    expect(clampAutopilotSetting("money", once)).toEqual(once);
  });

  it("nulls a monetary cap for a category that has no monetary effect", () => {
    const clamped = clampAutopilotSetting("customer", { enabled: true, maxAmountRial: 5_000_000, maxPercent: 9 });
    expect(clamped.maxAmountRial).toBeNull();
    expect(clamped.maxPercent).toBeNull();
  });

  it("defaults every category to disabled, so a stored row is never implicitly on", () => {
    for (const [category, setting] of Object.entries(AUTOPILOT_DEFAULTS)) {
      expect(setting.enabled, category).toBe(false);
      expect(clampAutopilotSetting(category as keyof typeof AUTOPILOT_DEFAULTS, {}).enabled).toBe(false);
    }
  });
});

describe("evaluateAutopilotProposal — gates", () => {
  it("defers an action with no autopilot category, whatever the settings say", () => {
    const verdict = evaluate("reservation.create", { customerName: "الف", partySize: 2 }, pricing);
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "action_not_eligible" });
  });

  it("defers a setup-wizard action even with every category enabled", () => {
    const verdict = evaluate("setup.business", { businessName: "کافه" }, pricing);
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "action_not_eligible" });
  });

  it("defers when the category is switched off", () => {
    const verdict = evaluate(
      "menu.item.priceUpdate",
      { menuItemId: "a", price: 105_000 },
      { ...pricing, enabled: false },
      { currentPriceRial: 100_000 },
    );
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "category_disabled" });
  });

  it("defers once the day's limit for the category is reached", () => {
    const verdict = evaluate(
      "menu.item.priceUpdate",
      { menuItemId: "a", price: 105_000 },
      pricing,
      { currentPriceRial: 100_000 },
      pricing.dailyActionLimit,
    );
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "daily_limit_reached" });
  });

  it("defers a proposal carrying more lines than the per-run item cap", () => {
    const lines = Array.from({ length: 9 }, (_, i) => ({ inventoryItemId: `i${i}`, countedQty: 1 }));
    const verdict = evaluate("inventory.adjustment.propose", { lines }, inventory, { documentValueRial: 10 });
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "too_many_items" });
  });
});

describe("evaluateAutopilotProposal — pricing", () => {
  it("applies a change inside both the percent and Rial caps", () => {
    const verdict = evaluate("menu.item.priceUpdate", { menuItemId: "a", price: 105_000 }, pricing, {
      currentPriceRial: 100_000,
    });
    expect(verdict.decision).toBe("auto_apply");
  });

  it("defers a change over the percent cap", () => {
    const verdict = evaluate("menu.item.priceUpdate", { menuItemId: "a", price: 140_000 }, pricing, {
      currentPriceRial: 100_000,
    });
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "price_change_too_large" });
  });

  it("defers a change inside the percent cap but over the absolute Rial cap", () => {
    // 5% of 100,000,000 is 5,000,000 — under 10% but far over the 1,000,000 cap.
    const verdict = evaluate("menu.item.priceUpdate", { menuItemId: "a", price: 105_000_000 }, pricing, {
      currentPriceRial: 100_000_000,
    });
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "amount_over_cap" });
  });

  it("defers when the item's current price is unknown, rather than passing the cap by default", () => {
    const verdict = evaluate("menu.item.priceUpdate", { menuItemId: "a", price: 105_000 }, pricing);
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "missing_context" });
  });

  it("defers a price of zero", () => {
    const verdict = evaluate("menu.item.priceUpdate", { menuItemId: "a", price: 0 }, pricing, {
      currentPriceRial: 100_000,
    });
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "invalid_payload" });
  });

  it("applies a disable but refuses a re-enable dressed as one", () => {
    expect(evaluate("menu.item.disable", { menuItemId: "a", isActive: false }, pricing).decision).toBe("auto_apply");
    expect(evaluate("menu.item.disable", { menuItemId: "a", isActive: true }, pricing)).toMatchObject({
      decision: "needs_confirmation",
      reasonCode: "invalid_payload",
    });
  });
});

describe("evaluateAutopilotProposal — money", () => {
  it("applies a discount inside both caps", () => {
    const verdict = evaluate(
      "order.discount.apply",
      { orderId: "o1", discount: { type: "percent", value: 5 } },
      money,
      { orderSubtotalRial: 2_000_000 },
    );
    expect(verdict.decision).toBe("auto_apply");
  });

  it("defers a small percentage of a large bill that breaches the Rial cap", () => {
    const verdict = evaluate(
      "order.discount.apply",
      { orderId: "o1", discount: { type: "percent", value: 5 } },
      money,
      { orderSubtotalRial: 500_000_000 },
    );
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "amount_over_cap" });
  });

  it("defers a small amount discount that breaches the percent cap", () => {
    const verdict = evaluate(
      "order.discount.apply",
      { orderId: "o1", discount: { type: "amount", value: 90_000 } },
      money,
      { orderSubtotalRial: 100_000 },
    );
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "amount_over_cap" });
  });

  it("defers a discount without a known order subtotal", () => {
    const verdict = evaluate("order.discount.apply", { orderId: "o1", discount: { type: "percent", value: 5 } }, money);
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "missing_context" });
  });

  it("applies an expense under the cap and defers one over it", () => {
    expect(
      evaluate("expense.categorize", { accountId: "a", paymentAccountId: "b", amount: 400_000, memo: "x" }, money)
        .decision,
    ).toBe("auto_apply");
    expect(
      evaluate("expense.categorize", { accountId: "a", paymentAccountId: "b", amount: 9_000_000, memo: "x" }, money),
    ).toMatchObject({ decision: "needs_confirmation", reasonCode: "amount_over_cap" });
  });

  it("refuses an unbalanced journal draft even though the draft path would too", () => {
    const verdict = evaluate(
      "journal.manual.propose",
      { memo: "x", lines: [{ accountId: "a", debit: 100 }, { accountId: "b", credit: 40 }] },
      money,
    );
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "unbalanced_entry" });
  });

  it("applies a balanced journal draft under the cap", () => {
    const verdict = evaluate(
      "journal.manual.propose",
      { memo: "x", lines: [{ accountId: "a", debit: 500_000 }, { accountId: "b", credit: 500_000 }] },
      money,
    );
    expect(verdict.decision).toBe("auto_apply");
  });

  it("defers a balanced journal draft whose total exceeds the cap", () => {
    const verdict = evaluate(
      "journal.manual.propose",
      { memo: "x", lines: [{ accountId: "a", debit: 9_000_000 }, { accountId: "b", credit: 9_000_000 }] },
      money,
    );
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "amount_over_cap" });
  });
});

describe("evaluateAutopilotProposal — inventory and customer", () => {
  it("applies an adjustment under the document-value cap and defers one over it", () => {
    const lines = [{ inventoryItemId: "i1", countedQty: 5 }];
    expect(evaluate("inventory.adjustment.propose", { lines }, inventory, { documentValueRial: 900_000 }).decision).toBe(
      "auto_apply",
    );
    expect(
      evaluate("inventory.adjustment.propose", { lines }, inventory, { documentValueRial: 90_000_000 }),
    ).toMatchObject({ decision: "needs_confirmation", reasonCode: "amount_over_cap" });
  });

  it("defers an inventory document whose value could not be computed", () => {
    const verdict = evaluate("inventory.adjustment.propose", { lines: [{ inventoryItemId: "i1" }] }, inventory);
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "missing_context" });
  });

  it("applies a plain customer note", () => {
    expect(evaluate("customer.note.add", { customerId: "c1", notes: "یادداشت" }, customer).decision).toBe("auto_apply");
  });

  it("refuses a note payload that reaches beyond the notes field", () => {
    // The endpoint is a full PUT on the customer, so this guard — not the
    // endpoint — is what stops a "note" quietly rewriting a phone number.
    const verdict = evaluate(
      "customer.note.add",
      { customerId: "c1", notes: "یادداشت", phone: "09120000000" },
      customer,
    );
    expect(verdict).toMatchObject({ decision: "needs_confirmation", reasonCode: "payload_touches_other_fields" });
  });

  it("refuses an empty note", () => {
    expect(evaluate("customer.note.add", { customerId: "c1", notes: "   " }, customer)).toMatchObject({
      decision: "needs_confirmation",
      reasonCode: "invalid_payload",
    });
  });
});

describe("actionTypesForCategory", () => {
  it("returns only that category's actions", () => {
    expect(actionTypesForCategory("pricing").sort()).toEqual(["menu.item.disable", "menu.item.priceUpdate"]);
    expect(actionTypesForCategory("customer")).toEqual(["customer.note.add"]);
  });

  it("gives waste no action at all — it detects and flags, it never logs waste", () => {
    expect(actionTypesForCategory("waste")).toEqual([]);
  });
});
