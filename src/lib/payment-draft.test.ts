import { describe, expect, it } from "vitest";
import {
  draftNeedsCustomer,
  draftOpensDrawer,
  draftReceiptPayments,
  draftRemaining,
  draftRowRial,
  emptyPaymentDraft,
  newDraftRow,
  paymentDraftBody,
  type PaymentDraft,
} from "./payment-draft";
import type { PaymentMethodView } from "./payment-methods";

function method(over: Partial<PaymentMethodView> & { id: string }): PaymentMethodView {
  return {
    code: over.id,
    name: over.id,
    settlement: "card",
    sortOrder: 10,
    isActive: true,
    isBuiltin: false,
    opensDrawer: false,
    requiresReference: false,
    ...over,
  };
}

const CASH = method({ id: "cash", name: "نقدی", settlement: "cash", opensDrawer: true, isBuiltin: true });
const CARD = method({ id: "card", name: "پوز ملت", settlement: "card", isBuiltin: true, sortOrder: 20 });
const CREDIT = method({ id: "credit", name: "نسیه", settlement: "credit", isBuiltin: true, sortOrder: 30 });
const TRANSFER = method({ id: "transfer", name: "کارت‌به‌کارت", settlement: "card_to_card", requiresReference: true });
const METHODS = [CASH, CARD, CREDIT, TRANSFER];

const DUE = 5_000_000; // ۵۰۰٬۰۰۰ تومان

function split(rows: { methodId: string; amount: string; reference?: string }[]): PaymentDraft {
  return {
    split: true,
    methodId: rows[0]?.methodId ?? "",
    rows: rows.map((row) => ({ ...newDraftRow(row.methodId, row.amount), reference: row.reference ?? "" })),
  };
}

describe("emptyPaymentDraft", () => {
  it("opens on the first way offered, not split", () => {
    const draft = emptyPaymentDraft(METHODS);
    expect(draft).toMatchObject({ split: false, methodId: "cash" });
    expect(draft.rows).toHaveLength(1);
  });

  it("survives a business with no ways configured", () => {
    expect(emptyPaymentDraft([]).methodId).toBe("");
  });
});

describe("draftRowRial", () => {
  it("reads Toman, Persian digits and separators alike", () => {
    expect(draftRowRial(newDraftRow("cash", "200000"))).toBe(2_000_000);
    expect(draftRowRial(newDraftRow("cash", "۲۰۰٬۰۰۰"))).toBe(2_000_000);
    expect(draftRowRial(newDraftRow("cash", "200,000"))).toBe(2_000_000);
  });

  it("reads Rial when the business chose Rial", () => {
    expect(draftRowRial(newDraftRow("cash", "200000"), "rial")).toBe(200_000);
  });

  it("is null while the box is empty, junk, zero or negative", () => {
    expect(draftRowRial(newDraftRow("cash", ""))).toBeNull();
    expect(draftRowRial(newDraftRow("cash", "  "))).toBeNull();
    expect(draftRowRial(newDraftRow("cash", "abc"))).toBeNull();
    expect(draftRowRial(newDraftRow("cash", "0"))).toBeNull();
    expect(draftRowRial(newDraftRow("cash", "-5"))).toBeNull();
  });
});

describe("draftRemaining", () => {
  it("is zero for an unsplit bill, whatever the total", () => {
    expect(draftRemaining(emptyPaymentDraft(METHODS), DUE)).toBe(0);
  });

  it("counts down as the rows are typed, and goes negative on an overshoot", () => {
    expect(draftRemaining(split([{ methodId: "cash", amount: "200000" }]), DUE)).toBe(3_000_000);
    expect(
      draftRemaining(split([{ methodId: "cash", amount: "200000" }, { methodId: "card", amount: "300000" }]), DUE),
    ).toBe(0);
    expect(draftRemaining(split([{ methodId: "cash", amount: "600000" }]), DUE)).toBe(-1_000_000);
  });

  it("treats a half-typed row as nothing yet, not as an error", () => {
    expect(
      draftRemaining(split([{ methodId: "cash", amount: "200000" }, { methodId: "card", amount: "" }]), DUE),
    ).toBe(3_000_000);
  });
});

describe("draftOpensDrawer / draftNeedsCustomer", () => {
  it("opens the drawer for any cash slice of a split", () => {
    expect(draftOpensDrawer(split([{ methodId: "card", amount: "500000" }]), METHODS)).toBe(false);
    expect(
      draftOpensDrawer(split([{ methodId: "card", amount: "300000" }, { methodId: "cash", amount: "200000" }]), METHODS),
    ).toBe(true);
    expect(draftOpensDrawer(emptyPaymentDraft(METHODS), METHODS)).toBe(true);
  });

  it("needs a customer as soon as one slice is on a tab", () => {
    expect(draftNeedsCustomer(split([{ methodId: "cash", amount: "500000" }]), METHODS)).toBe(false);
    expect(
      draftNeedsCustomer(
        split([{ methodId: "cash", amount: "300000" }, { methodId: "credit", amount: "200000" }]),
        METHODS,
      ),
    ).toBe(true);
  });
});

describe("paymentDraftBody", () => {
  it("sends one way and no amount when the bill is not split", () => {
    expect(paymentDraftBody(emptyPaymentDraft(METHODS), METHODS, DUE)).toEqual({
      ok: true,
      value: [{ methodId: "cash", reference: undefined }],
    });
  });

  it("prices every slice but the last, which takes whatever is left", () => {
    const draft = split([
      { methodId: "cash", amount: "۲۰۰٬۰۰۰" },
      { methodId: "card", amount: "300000" },
    ]);
    expect(paymentDraftBody(draft, METHODS, DUE)).toEqual({
      ok: true,
      value: [
        { methodId: "cash", amount: 2_000_000, reference: undefined },
        { methodId: "card", amount: undefined, reference: undefined },
      ],
    });
  });

  it("refuses a split that does not add up to the bill", () => {
    const draft = split([
      { methodId: "cash", amount: "200000" },
      { methodId: "card", amount: "200000" },
    ]);
    expect(paymentDraftBody(draft, METHODS, DUE)).toEqual({ ok: false, error: "payment_total_mismatch" });
  });

  it("refuses a slice whose amount is still empty", () => {
    const draft = split([{ methodId: "cash", amount: "500000" }, { methodId: "card", amount: "" }]);
    expect(paymentDraftBody(draft, METHODS, DUE)).toEqual({ ok: false, error: "invalid_amount" });
  });

  it("refuses a way that demands a reference until one is typed", () => {
    const draft = split([{ methodId: "transfer", amount: "500000" }]);
    expect(paymentDraftBody(draft, METHODS, DUE)).toEqual({ ok: false, error: "payment_reference_required" });
    const withReference = split([{ methodId: "transfer", amount: "500000", reference: " 5541 " }]);
    expect(paymentDraftBody(withReference, METHODS, DUE)).toEqual({
      ok: true,
      value: [{ methodId: "transfer", amount: undefined, reference: "5541" }],
    });
  });

  it("prices slices in Rial when the business chose Rial", () => {
    const draft = split([
      { methodId: "cash", amount: "300000" },
      { methodId: "card", amount: "200000" },
    ]);
    expect(paymentDraftBody(draft, METHODS, 500_000, "rial")).toEqual({
      ok: true,
      value: [
        { methodId: "cash", amount: 300_000, reference: undefined },
        { methodId: "card", amount: undefined, reference: undefined },
      ],
    });
  });

  it("refuses a way that is no longer offered", () => {
    expect(paymentDraftBody(split([{ methodId: "gone", amount: "500000" }]), METHODS, DUE)).toEqual({
      ok: false,
      error: "invalid_payment_method",
    });
  });

  it("refuses a split with no rows left", () => {
    expect(paymentDraftBody({ split: true, methodId: "cash", rows: [] }, METHODS, DUE)).toEqual({
      ok: false,
      error: "no_payment",
    });
  });
});

describe("draftReceiptPayments", () => {
  it("prints the way's own name and the whole bill when unsplit", () => {
    expect(draftReceiptPayments({ split: false, methodId: "card", rows: [] }, METHODS, DUE)).toEqual([
      { label: "پوز ملت", amount: DUE },
    ]);
  });

  it("prints a line per slice", () => {
    const draft = split([
      { methodId: "cash", amount: "200000" },
      { methodId: "card", amount: "300000" },
    ]);
    expect(draftReceiptPayments(draft, METHODS, DUE)).toEqual([
      { label: "نقدی", amount: 2_000_000 },
      { label: "پوز ملت", amount: 3_000_000 },
    ]);
  });

  it("leaves out a slice that is not a payable amount yet", () => {
    const draft = split([{ methodId: "cash", amount: "200000" }, { methodId: "card", amount: "" }]);
    expect(draftReceiptPayments(draft, METHODS, DUE)).toEqual([{ label: "نقدی", amount: 2_000_000 }]);
  });
});
