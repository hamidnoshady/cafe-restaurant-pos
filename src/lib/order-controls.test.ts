import { describe, expect, it } from "vitest";
import { assertOrderControl, normalizeVoidReason, type OrderControlPolicy } from "./order-controls";

const policy: OrderControlPolicy = {
  cashierDiscountLimitPercent: 10,
  wholeOrderVoidRequiresManager: true,
  postKitchenChangeRequiresManager: true,
};

describe("order controls", () => {
  it("requires a meaningful reason for order and item voids", () => {
    expect(() => normalizeVoidReason(" \t ")).toThrowError("void_reason_required");
    expect(normalizeVoidReason("  اشتباه ثبت شد  ")).toBe("اشتباه ثبت شد");
  });

  it("enforces cashier discount thresholds", () => {
    expect(() =>
      assertOrderControl({
        policy,
        actorRole: "cashier",
        action: "discount",
        discountPercent: 11,
        kitchenStarted: false,
      }),
    ).toThrowError("manager_approval_required");

    expect(() =>
      assertOrderControl({
        policy,
        actorRole: "cashier",
        action: "discount",
        discountPercent: 10,
        kitchenStarted: false,
      }),
    ).not.toThrow();
  });

  it("requires manager authority for whole-order void and post-kitchen changes", () => {
    for (const action of ["order_void", "item_quantity", "item_void"] as const) {
      expect(() =>
        assertOrderControl({
          policy,
          actorRole: "cashier",
          action,
          kitchenStarted: action !== "order_void",
        }),
      ).toThrowError("manager_approval_required");
      expect(() =>
        assertOrderControl({
          policy,
          actorRole: "manager",
          action,
          kitchenStarted: true,
        }),
      ).not.toThrow();
    }
  });
});