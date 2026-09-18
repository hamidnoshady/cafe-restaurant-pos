import { describe, expect, it } from "vitest";
import {
  BUILTIN_PAYMENT_METHODS,
  CUSTOM_PAYMENT_SETTLEMENTS,
  builtinPaymentMethodsFor,
  changeDue,
  isExactPaymentMethodOrder,
  ledgerSettlementFor,
  paymentMethodCodeFor,
  platformCommissionBase,
  remainingAfterTenders,
  sortPaymentMethods,
  tenderTotal,
  tendersBySettlement,
  tendersWithTip,
  tipTenderIndex,
  validatePaymentMethodInput,
  validateTenders,
} from "./payment-methods";

describe("builtinPaymentMethodsFor", () => {
  it("gives SnapFood to food service only", () => {
    expect(builtinPaymentMethodsFor("food_service").map((m) => m.code)).toContain("snappfood");
    expect(builtinPaymentMethodsFor("jewelry").map((m) => m.code)).not.toContain("snappfood");
  });

  it("gives every trade the five common ways", () => {
    expect(builtinPaymentMethodsFor("cosmetics").map((m) => m.code)).toEqual([
      "cash",
      "card",
      "card_to_card",
      "online",
      "credit",
    ]);
  });

  it("marks only cash as opening the drawer", () => {
    expect(BUILTIN_PAYMENT_METHODS.filter((m) => m.opensDrawer).map((m) => m.code)).toEqual(["cash"]);
  });
});

describe("sortPaymentMethods", () => {
  it("orders by sortOrder, then name", () => {
    const sorted = sortPaymentMethods([
      { sortOrder: 20, name: "کارت‌خوان" },
      { sortOrder: 10, name: "نقدی" },
      { sortOrder: 20, name: "آپ" },
    ]);
    expect(sorted.map((m) => m.name)).toEqual(["نقدی", "آپ", "کارت‌خوان"]);
  });

  it("does not mutate its input", () => {
    const input = [{ sortOrder: 2, name: "ب" }, { sortOrder: 1, name: "الف" }];
    sortPaymentMethods(input);
    expect(input.map((m) => m.name)).toEqual(["ب", "الف"]);
  });
});

describe("isExactPaymentMethodOrder", () => {
  const current = ["cash-id", "card-id", "online-id"];

  it("accepts every current id exactly once in any order", () => {
    expect(isExactPaymentMethodOrder(current, ["online-id", "cash-id", "card-id"])).toBe(true);
  });

  it("rejects subsets, duplicates, and foreign ids", () => {
    expect(isExactPaymentMethodOrder(current, ["cash-id", "card-id"])).toBe(false);
    expect(isExactPaymentMethodOrder(current, ["cash-id", "cash-id", "online-id"])).toBe(false);
    expect(isExactPaymentMethodOrder(current, ["cash-id", "card-id", "foreign-id"])).toBe(false);
  });
});

describe("paymentMethodCodeFor", () => {
  it("slugifies an ASCII name", () => {
    expect(paymentMethodCodeFor("Wallet Pay", [])).toBe("wallet_pay");
  });

  it("falls back to 'custom' for a Persian name, then de-duplicates", () => {
    expect(paymentMethodCodeFor("کیف پول", [])).toBe("custom");
    expect(paymentMethodCodeFor("کیف پول", ["custom"])).toBe("custom_2");
    expect(paymentMethodCodeFor("کیف پول", ["custom", "custom_2"])).toBe("custom_3");
  });

  it("never collides with a built-in code", () => {
    expect(paymentMethodCodeFor("cash", ["cash"])).toBe("cash_2");
  });
});

describe("validatePaymentMethodInput", () => {
  it("rejects an empty or over-long name", () => {
    expect(validatePaymentMethodInput({ name: "  ", settlement: "cash" })).toEqual({
      ok: false,
      error: "invalid_name",
    });
    expect(validatePaymentMethodInput({ name: "ی".repeat(41), settlement: "cash" })).toEqual({
      ok: false,
      error: "invalid_name",
    });
  });

  it("rejects a settlement a business may not mint", () => {
    expect(validatePaymentMethodInput({ name: "اسنپ دوم", settlement: "snappfood" })).toEqual({
      ok: false,
      error: "invalid_settlement",
    });
    expect(validatePaymentMethodInput({ name: "بیت‌کوین", settlement: "crypto" })).toEqual({
      ok: false,
      error: "invalid_settlement",
    });
    expect(CUSTOM_PAYMENT_SETTLEMENTS).not.toContain("snappfood");
  });

  it("defaults opensDrawer to whether it settles as cash", () => {
    const cashLike = validatePaymentMethodInput({ name: "صندوق دوم", settlement: "cash" });
    expect(cashLike).toEqual({
      ok: true,
      value: { name: "صندوق دوم", settlement: "cash", opensDrawer: true, requiresReference: false },
    });
    const cardLike = validatePaymentMethodInput({ name: "پوز ملت", settlement: "card", requiresReference: true });
    expect(cardLike).toEqual({
      ok: true,
      value: { name: "پوز ملت", settlement: "card", opensDrawer: false, requiresReference: true },
    });
  });

  it("honours an explicit opensDrawer over the default", () => {
    expect(validatePaymentMethodInput({ name: "تنخواه", settlement: "cash", opensDrawer: false })).toEqual({
      ok: true,
      value: { name: "تنخواه", settlement: "cash", opensDrawer: false, requiresReference: false },
    });
  });

  it("rejects truthy strings instead of silently treating them as enabled", () => {
    expect(validatePaymentMethodInput({ name: "تنخواه", settlement: "cash", opensDrawer: "false" })).toEqual({
      ok: false,
      error: "bad_request",
    });
    expect(validatePaymentMethodInput({ name: "پوز", settlement: "card", requiresReference: 1 })).toEqual({
      ok: false,
      error: "bad_request",
    });
  });
});

describe("tenderTotal / remainingAfterTenders", () => {
  it("adds the slices up and reports what is left", () => {
    const tenders = [{ amount: 2_000_000 }, { amount: 3_000_000 }];
    expect(tenderTotal(tenders)).toBe(5_000_000);
    expect(remainingAfterTenders(tenders, 8_000_000)).toBe(3_000_000);
    expect(remainingAfterTenders(tenders, 5_000_000)).toBe(0);
    expect(remainingAfterTenders(tenders, 4_000_000)).toBe(-1_000_000);
  });
});

describe("changeDue", () => {
  it("gives back an overshoot that was paid in cash", () => {
    expect(changeDue([{ settlement: "cash", amount: 5_000_000 }], 4_700_000)).toBe(300_000);
  });

  it("is zero when the tenders land exactly", () => {
    expect(
      changeDue(
        [
          { settlement: "cash", amount: 2_000_000 },
          { settlement: "card", amount: 3_000_000 },
        ],
        5_000_000,
      ),
    ).toBe(0);
  });

  it("never hands back more than the cash in the split", () => {
    // A card over-swiped by 1,000,000 is a mistake; only the 200,000 of cash
    // can come back out of the drawer.
    expect(
      changeDue(
        [
          { settlement: "cash", amount: 200_000 },
          { settlement: "card", amount: 5_000_000 },
        ],
        4_000_000,
      ),
    ).toBe(200_000);
  });
});

describe("validateTenders", () => {
  const due = 5_000_000;
  const ok = { due, hasCustomer: false };

  it("accepts a single tender covering the bill", () => {
    const result = validateTenders([{ methodId: "m1", settlement: "cash", amount: due }], ok);
    expect(result).toEqual({
      ok: true,
      value: [{ methodId: "m1", settlement: "cash", amount: due, reference: null }],
    });
  });

  it("accepts a cash + card split that adds up", () => {
    const result = validateTenders(
      [
        { methodId: "m1", settlement: "cash", amount: 2_000_000 },
        { methodId: "m2", settlement: "card", amount: 3_000_000, reference: " 4421 " },
      ],
      ok,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((t) => t.amount)).toEqual([2_000_000, 3_000_000]);
      expect(result.value[1].reference).toBe("4421");
    }
  });

  it("lets one slice take whatever is left", () => {
    // «۲۰۰٬۰۰۰ نقدی، بقیه با کارت» — the card slice carries no amount.
    const result = validateTenders(
      [
        { settlement: "cash", amount: 2_000_000 },
        { settlement: "card" },
      ],
      ok,
    );
    expect(result).toEqual({
      ok: true,
      value: [
        { methodId: null, settlement: "cash", amount: 2_000_000, reference: null },
        { methodId: null, settlement: "card", amount: 3_000_000, reference: null },
      ],
    });
  });

  it("gives an only, unpriced slice the whole bill", () => {
    const result = validateTenders([{ settlement: "cash" }], ok);
    expect(result.ok && result.value[0].amount).toBe(due);
  });

  it("refuses more than one open slice — 'the rest' has to mean one thing", () => {
    expect(validateTenders([{ settlement: "cash" }, { settlement: "card" }], ok)).toEqual({
      ok: false,
      error: "payment_total_mismatch",
    });
  });

  it("refuses an open slice with nothing left for it", () => {
    expect(
      validateTenders([{ settlement: "cash", amount: due }, { settlement: "card" }], ok),
    ).toEqual({ ok: false, error: "invalid_amount" });
  });

  it("rejects a split that misses the total in either direction", () => {
    expect(
      validateTenders(
        [
          { settlement: "cash", amount: 2_000_000 },
          { settlement: "card", amount: 2_000_000 },
        ],
        ok,
      ),
    ).toEqual({ ok: false, error: "payment_total_mismatch" });
    expect(
      validateTenders(
        [
          { settlement: "cash", amount: 4_000_000 },
          { settlement: "card", amount: 2_000_000 },
        ],
        ok,
      ),
    ).toEqual({ ok: false, error: "payment_total_mismatch" });
  });

  it("rejects an empty, zero, fractional or negative slice", () => {
    expect(validateTenders([], ok)).toEqual({ ok: false, error: "no_payment" });
    expect(validateTenders([{ settlement: "cash", amount: 0 }], { due: 0, hasCustomer: false })).toEqual({
      ok: false,
      error: "invalid_amount",
    });
    expect(validateTenders([{ settlement: "cash", amount: -5 }], ok)).toEqual({ ok: false, error: "invalid_amount" });
    expect(validateTenders([{ settlement: "cash", amount: 1.5 }], ok)).toEqual({ ok: false, error: "invalid_amount" });
  });

  it("rejects an unknown settlement", () => {
    expect(validateTenders([{ settlement: "bitcoin" as never, amount: due }], ok)).toEqual({
      ok: false,
      error: "invalid_payment_method",
    });
  });

  it("requires a customer as soon as one slice is on credit", () => {
    const tenders = [
      { settlement: "cash" as const, amount: 3_000_000 },
      { settlement: "credit" as const, amount: 2_000_000 },
    ];
    expect(validateTenders(tenders, { due, hasCustomer: false })).toEqual({ ok: false, error: "customer_required" });
    expect(validateTenders(tenders, { due, hasCustomer: true }).ok).toBe(true);
  });

  it("caps how many slices one bill can be cut into", () => {
    const tenders = Array.from({ length: 11 }, () => ({ settlement: "cash" as const, amount: 1 }));
    expect(validateTenders(tenders, { due: 11, hasCustomer: false })).toEqual({ ok: false, error: "too_many_tenders" });
  });
});

describe("tendersBySettlement", () => {
  it("merges slices sharing a settlement, in settlement order", () => {
    expect(
      tendersBySettlement([
        { settlement: "card", amount: 3_000_000 },
        { settlement: "cash", amount: 1_000_000 },
        { settlement: "card", amount: 500_000 },
      ]),
    ).toEqual([
      { settlement: "cash", amount: 1_000_000 },
      { settlement: "card", amount: 3_500_000 },
    ]);
  });

  it("is empty for no tenders", () => {
    expect(tendersBySettlement([])).toEqual([]);
  });
});

describe("tipTenderIndex / tendersWithTip", () => {
  it("puts the tip on the first slice that collected money", () => {
    const tenders = [
      { settlement: "cash" as const, amount: 2_000_000 },
      { settlement: "card" as const, amount: 3_000_000 },
    ];
    expect(tipTenderIndex(tenders)).toBe(0);
    expect(tendersWithTip(tenders, 100_000)).toEqual([
      { settlement: "cash", amount: 2_100_000 },
      { settlement: "card", amount: 3_000_000 },
    ]);
  });

  it("passes over a credit slice — a tip is not put on a tab", () => {
    const tenders = [
      { settlement: "credit" as const, amount: 2_000_000 },
      { settlement: "card" as const, amount: 3_000_000 },
    ];
    expect(tipTenderIndex(tenders)).toBe(1);
    expect(tendersWithTip(tenders, 100_000)[1].amount).toBe(3_100_000);
  });

  it("falls back to the credit slice when the whole bill is on credit", () => {
    const tenders = [{ settlement: "credit" as const, amount: 2_000_000 }];
    expect(tipTenderIndex(tenders)).toBe(0);
    expect(tendersWithTip(tenders, 100_000)[0].amount).toBe(2_100_000);
  });

  it("leaves the slices alone when there is no tip, and copies rather than mutates", () => {
    const tenders = [{ settlement: "cash" as const, amount: 2_000_000 }];
    expect(tendersWithTip(tenders, 0)).toEqual(tenders);
    tendersWithTip(tenders, 500_000);
    expect(tenders[0].amount).toBe(2_000_000);
    expect(tipTenderIndex([])).toBe(-1);
    expect(tendersWithTip([], 500_000)).toEqual([]);
  });
});

describe("platformCommissionBase", () => {
  it("uses only the SnapFood bill slice, excluding cash and the separately stored tip", () => {
    expect(
      platformCommissionBase([
        { settlement: "snappfood", amount: 800_000 },
        { settlement: "cash", amount: 200_000 },
      ]),
    ).toBe(800_000);
  });

  it("keeps the bill slice correct regardless of tender order", () => {
    expect(
      platformCommissionBase([
        { settlement: "cash", amount: 100_000 },
        { settlement: "snappfood", amount: 800_000 },
      ]),
    ).toBe(800_000);
  });
});

describe("ledgerSettlementFor", () => {
  it("narrows every card-shaped way to the ledger's single 'bank'", () => {
    expect(ledgerSettlementFor("card")).toBe("bank");
    expect(ledgerSettlementFor("card_to_card")).toBe("bank");
    expect(ledgerSettlementFor("online")).toBe("bank");
  });

  it("passes cash and credit through", () => {
    expect(ledgerSettlementFor("cash")).toBe("cash");
    expect(ledgerSettlementFor("credit")).toBe("credit");
  });

  it("has nowhere to put SnapFood, which never reaches a retail invoice", () => {
    expect(ledgerSettlementFor("snappfood")).toBeNull();
  });
});
