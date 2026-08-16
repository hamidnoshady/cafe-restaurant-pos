import { describe, expect, it } from "vitest";
import {
  MAX_LINE_QUANTITY,
  planOrderLines,
  planPaymentRows,
  validateAmendment,
  type AmendmentInput,
} from "./order-amendments";

function edit(overrides: Partial<AmendmentInput> = {}): AmendmentInput {
  return {
    kind: "edit",
    reason: "مشتری یک نوشیدنی را پس داد",
    lines: [{ orderItemId: "item-1", quantity: 1 }],
    ...overrides,
  };
}

describe("validateAmendment", () => {
  it("requires a reason for both kinds", () => {
    expect(validateAmendment({ kind: "void" })).toEqual({ ok: false, error: "reason_required" });
    expect(validateAmendment(edit({ reason: "  " }))).toEqual({ ok: false, error: "reason_required" });
    expect(validateAmendment({ kind: "void", reason: "اشتباه صندوق" }).ok).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(validateAmendment({ kind: "delete" as never, reason: "x y z" })).toEqual({
      ok: false,
      error: "invalid_amendment_kind",
    });
  });

  it("ignores the line list for a removal but demands one for an edit", () => {
    const removal = validateAmendment({ kind: "void", reason: "سفارش تکراری", lines: [{ quantity: 2 }] });
    expect(removal.ok && removal.value.lines).toEqual([]);
    expect(validateAmendment(edit({ lines: [] }))).toEqual({ ok: false, error: "no_items" });
  });

  it("holds edited lines to the same shape the POS enforces", () => {
    expect(validateAmendment(edit({ lines: [{ orderItemId: "item-1", quantity: 0 }] }))).toEqual({
      ok: false,
      error: "invalid_item",
    });
    expect(
      validateAmendment(edit({ lines: [{ orderItemId: "item-1", quantity: MAX_LINE_QUANTITY + 1 }] })),
    ).toEqual({ ok: false, error: "invalid_item" });
    expect(validateAmendment(edit({ lines: [{ quantity: 2 }] }))).toEqual({
      ok: false,
      error: "invalid_item",
    });
    expect(validateAmendment(edit({ lines: [{ menuItemId: "menu-1", quantity: 2 }] })).ok).toBe(true);
  });

  it("validates the discount the same way the open-order route does", () => {
    expect(validateAmendment(edit({ discount: { type: "percent", value: 120 } }))).toEqual({
      ok: false,
      error: "invalid_discount",
    });
    expect(validateAmendment(edit({ discount: { type: "amount", value: -1 } }))).toEqual({
      ok: false,
      error: "invalid_discount",
    });
    const ok = validateAmendment(edit({ discount: { type: "percent", value: 10 } }));
    expect(ok.ok && ok.value.discount).toEqual({ type: "percent", value: 10 });
  });

  it("normalises an absent discount to 'no discount' rather than zero-percent", () => {
    const result = validateAmendment(edit());
    expect(result.ok && result.value.discount).toEqual({ type: null, value: 0 });
  });

  it("rejects a fractional or negative tip and keeps 'unchanged' distinct from zero", () => {
    expect(validateAmendment(edit({ tipAmount: -1 }))).toEqual({ ok: false, error: "invalid_tip_amount" });
    expect(validateAmendment(edit({ tipAmount: 1.5 }))).toEqual({ ok: false, error: "invalid_tip_amount" });
    const unchanged = validateAmendment(edit());
    expect(unchanged.ok && unchanged.value.tipAmount).toBeNull();
    const cleared = validateAmendment(edit({ tipAmount: 0 }));
    expect(cleared.ok && cleared.value.tipAmount).toBe(0);
  });

  it("rejects a payment method the till cannot take", () => {
    expect(validateAmendment(edit({ paymentMethod: "cheque" }))).toEqual({
      ok: false,
      error: "invalid_payment_method",
    });
    expect(validateAmendment(edit({ paymentMethod: "card" })).ok).toBe(true);
  });
});

describe("planOrderLines", () => {
  const current = [
    { id: "item-1", quantity: 2 },
    { id: "item-2", quantity: 1 },
  ];

  it("voids every current line the desired set leaves out", () => {
    const plan = planOrderLines(current, [{ orderItemId: "item-1", quantity: 2 }]);
    expect(plan.ok && plan.value.voids).toEqual(["item-2"]);
    expect(plan.ok && plan.value.updates).toEqual([
      { orderItemId: "item-1", quantity: 2, note: undefined },
    ]);
    expect(plan.ok && plan.value.additions).toEqual([]);
  });

  it("re-quantifies a kept line and adds a new one", () => {
    const plan = planOrderLines(current, [
      { orderItemId: "item-1", quantity: 1 },
      { orderItemId: "item-2", quantity: 1 },
      { menuItemId: "menu-9", quantity: 3, note: "  بدون شکر  ", modifierIds: ["mod-1"] },
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.updates.map((u) => u.quantity)).toEqual([1, 1]);
    expect(plan.value.voids).toEqual([]);
    expect(plan.value.additions).toEqual([
      { menuItemId: "menu-9", quantity: 3, note: "بدون شکر", modifierIds: ["mod-1"] },
    ]);
  });

  it("refuses a line that is not on the order, or named twice", () => {
    expect(planOrderLines(current, [{ orderItemId: "item-9", quantity: 1 }])).toEqual({
      ok: false,
      error: "item_not_found",
    });
    expect(
      planOrderLines(current, [
        { orderItemId: "item-1", quantity: 1 },
        { orderItemId: "item-1", quantity: 2 },
      ]),
    ).toEqual({ ok: false, error: "duplicate_item" });
  });

  it("refuses an edit that would leave the order with nothing on it", () => {
    expect(planOrderLines(current, [])).toEqual({ ok: false, error: "no_items" });
  });
});

describe("planPaymentRows", () => {
  it("cancels the whole balance when the order is removed", () => {
    expect(planPaymentRows([{ method: "cash", amount: 250_000 }], 0, null)).toEqual([
      { method: "cash", amount: -250_000 },
    ]);
  });

  it("cancels then re-settles at the corrected total", () => {
    expect(planPaymentRows([{ method: "card", amount: 250_000 }], 180_000, null)).toEqual([
      { method: "card", amount: -250_000 },
      { method: "card", amount: 180_000 },
    ]);
  });

  it("re-settles through the method the amendment names", () => {
    expect(planPaymentRows([{ method: "credit", amount: 100_000 }], 100_000, "cash")).toEqual([
      { method: "credit", amount: -100_000 },
      { method: "cash", amount: 100_000 },
    ]);
  });

  it("nets a refund already recorded against the order before reversing", () => {
    expect(
      planPaymentRows(
        [
          { method: "cash", amount: 250_000 },
          { method: "cash", amount: -50_000 },
        ],
        0,
        null,
      ),
    ).toEqual([{ method: "cash", amount: -200_000 }]);
  });

  it("leaves a fully refunded order alone rather than writing a zero row", () => {
    expect(
      planPaymentRows(
        [
          { method: "cash", amount: 100_000 },
          { method: "cash", amount: -100_000 },
        ],
        0,
        null,
      ),
    ).toEqual([]);
  });

  it("re-settles a split-tender order on its largest method by default", () => {
    expect(
      planPaymentRows(
        [
          { method: "cash", amount: 40_000 },
          { method: "card", amount: 160_000 },
        ],
        150_000,
        null,
      ),
    ).toEqual([
      { method: "cash", amount: -40_000 },
      { method: "card", amount: -160_000 },
      { method: "card", amount: 150_000 },
    ]);
  });

  it("falls back to cash when there is nothing to learn the method from", () => {
    expect(planPaymentRows([], 90_000, null)).toEqual([{ method: "cash", amount: 90_000 }]);
  });
});
