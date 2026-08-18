import { describe, expect, it } from "vitest";
import {
  buildCogsLines,
  buildOrderPaymentLines,
  buildPurchaseLines,
  buildWasteLines,
  checkBalance,
  revenueAccountCodeForOrderChannel,
  validateJournalLines,
  type JournalLine,
} from "./ledger";

const ORDER_ACCOUNTS = {
  cash: "cash",
  bankClearing: "bank",
  accountsReceivable: "ar",
  chequesOnHand: "cheques",
  salesRevenue: "revenue",
  vatPayable: "vat",
};

describe("checkBalance", () => {
  it("is balanced when debits equal credits", () => {
    const lines: JournalLine[] = [
      { accountId: "a", debit: 100, credit: 0 },
      { accountId: "b", debit: 0, credit: 100 },
    ];
    expect(checkBalance(lines)).toMatchObject({ totalDebit: 100, totalCredit: 100, difference: 0, balanced: true });
  });

  it("reports the difference when unbalanced", () => {
    const lines: JournalLine[] = [
      { accountId: "a", debit: 100, credit: 0 },
      { accountId: "b", debit: 0, credit: 60 },
    ];
    expect(checkBalance(lines)).toMatchObject({ difference: 40, balanced: false });
  });
});

describe("validateJournalLines", () => {
  it("accepts a balanced, well-formed entry", () => {
    expect(
      validateJournalLines([
        { accountId: "a", debit: 100, credit: 0 },
        { accountId: "b", debit: 0, credit: 100 },
      ]),
    ).toEqual([]);
  });

  it("rejects an empty entry", () => {
    expect(validateJournalLines([])).not.toEqual([]);
  });

  it("rejects an unbalanced entry", () => {
    expect(
      validateJournalLines([
        { accountId: "a", debit: 100, credit: 0 },
        { accountId: "b", debit: 0, credit: 90 },
      ]),
    ).not.toEqual([]);
  });

  it("rejects a line with both debit and credit set", () => {
    expect(validateJournalLines([{ accountId: "a", debit: 50, credit: 50 }])).not.toEqual([]);
  });

  it("rejects a line missing its account", () => {
    expect(
      validateJournalLines([
        { accountId: "", debit: 100, credit: 0 },
        { accountId: "b", debit: 0, credit: 100 },
      ]),
    ).not.toEqual([]);
  });

  it("rejects negative or non-integer amounts", () => {
    expect(
      validateJournalLines([
        { accountId: "a", debit: -10, credit: 0 },
        { accountId: "b", debit: 0, credit: -10 },
      ]),
    ).not.toEqual([]);
  });
});

describe("buildOrderPaymentLines", () => {
  it("cash payment: debits Cash, credits Sales Revenue net of tax + Tax Payable", () => {
    const lines = buildOrderPaymentLines(ORDER_ACCOUNTS, { method: "cash", amount: 110_000, tax: 10_000 });
    expect(checkBalance(lines).balanced).toBe(true);
    expect(lines).toEqual([
      { accountId: "cash", debit: 110_000, credit: 0 },
      { accountId: "revenue", debit: 0, credit: 100_000 },
      { accountId: "vat", debit: 0, credit: 10_000 },
    ]);
  });

  it("card/online payments debit Bank/Clearing instead of Cash", () => {
    for (const method of ["card", "card_to_card", "online"]) {
      const lines = buildOrderPaymentLines(ORDER_ACCOUNTS, { method, amount: 50_000, tax: 0 });
      expect(lines[0]).toEqual({ accountId: "bank", debit: 50_000, credit: 0 });
    }
  });

  it("credit (tab) payment debits Accounts Receivable", () => {
    const lines = buildOrderPaymentLines(ORDER_ACCOUNTS, { method: "credit", amount: 50_000, tax: 0 });
    expect(lines[0]).toEqual({ accountId: "ar", debit: 50_000, credit: 0 });
  });

  it("omits the tax line when there is no tax", () => {
    const lines = buildOrderPaymentLines(ORDER_ACCOUNTS, { method: "cash", amount: 50_000, tax: 0 });
    expect(lines).toEqual([
      { accountId: "cash", debit: 50_000, credit: 0 },
      { accountId: "revenue", debit: 0, credit: 50_000 },
    ]);
  });

  it("returns nothing for a zero-amount order", () => {
    expect(buildOrderPaymentLines(ORDER_ACCOUNTS, { method: "cash", amount: 0, tax: 0 })).toEqual([]);
  });

  it("splits a bill across tenders: one debit line each, one revenue credit", () => {
    const lines = buildOrderPaymentLines(ORDER_ACCOUNTS, {
      tenders: [
        { method: "cash", amount: 40_000 },
        { method: "card", amount: 70_000 },
      ],
      amount: 110_000,
      tax: 10_000,
    });
    expect(checkBalance(lines).balanced).toBe(true);
    expect(lines).toEqual([
      { accountId: "cash", debit: 40_000, credit: 0 },
      { accountId: "bank", debit: 70_000, credit: 0 },
      { accountId: "revenue", debit: 0, credit: 100_000 },
      { accountId: "vat", debit: 0, credit: 10_000 },
    ]);
  });

  it("posts nothing for a split that does not add up to the bill", () => {
    expect(
      buildOrderPaymentLines(ORDER_ACCOUNTS, {
        tenders: [
          { method: "cash", amount: 40_000 },
          { method: "card", amount: 50_000 },
        ],
        amount: 110_000,
        tax: 0,
      }),
    ).toEqual([]);
  });

  it("posts nothing for a split holding a zero or negative slice", () => {
    expect(
      buildOrderPaymentLines(ORDER_ACCOUNTS, {
        tenders: [
          { method: "cash", amount: 110_000 },
          { method: "card", amount: 0 },
        ],
        amount: 110_000,
        tax: 0,
      }),
    ).toEqual([]);
  });
});

describe("revenueAccountCodeForOrderChannel", () => {
  const CHANNEL_CODES = { dineInRevenue: "4310", takeawayRevenue: "4320", deliveryRevenue: "4330" };

  it("maps each channel to its own revenue account", () => {
    expect(revenueAccountCodeForOrderChannel("dine_in", CHANNEL_CODES)).toBe("4310");
    expect(revenueAccountCodeForOrderChannel("takeaway", CHANNEL_CODES)).toBe("4320");
    expect(revenueAccountCodeForOrderChannel("delivery", CHANNEL_CODES)).toBe("4330");
  });
});

describe("buildCogsLines", () => {
  it("debits COGS, credits Inventory, balanced", () => {
    const lines = buildCogsLines({ cogs: "cogs", inventory: "inv" }, 25_000);
    expect(lines).toEqual([
      { accountId: "cogs", debit: 25_000, credit: 0 },
      { accountId: "inv", debit: 0, credit: 25_000 },
    ]);
    expect(checkBalance(lines).balanced).toBe(true);
  });

  it("returns nothing for zero cost", () => {
    expect(buildCogsLines({ cogs: "cogs", inventory: "inv" }, 0)).toEqual([]);
  });
});

describe("buildWasteLines", () => {
  it("debits Waste Expense, credits Inventory, balanced", () => {
    const lines = buildWasteLines({ wasteExpense: "waste", inventory: "inv" }, 8_000);
    expect(lines).toEqual([
      { accountId: "waste", debit: 8_000, credit: 0 },
      { accountId: "inv", debit: 0, credit: 8_000 },
    ]);
    expect(checkBalance(lines).balanced).toBe(true);
  });
});

describe("buildPurchaseLines", () => {
  const PURCHASE_ACCOUNTS = { inventory: "inv", accountsPayable: "ap", cash: "cash", bankClearing: "bank" };

  it("credit terms (default): debits Inventory, credits Accounts Payable", () => {
    const lines = buildPurchaseLines(PURCHASE_ACCOUNTS, { total: 300_000, settlementMethod: "credit" });
    expect(lines).toEqual([
      { accountId: "inv", debit: 300_000, credit: 0 },
      { accountId: "ap", debit: 0, credit: 300_000 },
    ]);
  });

  it("paid in cash: credits Cash instead of Accounts Payable", () => {
    const lines = buildPurchaseLines(PURCHASE_ACCOUNTS, { total: 300_000, settlementMethod: "cash" });
    expect(lines[1]).toEqual({ accountId: "cash", debit: 0, credit: 300_000 });
  });

  it("paid by bank/card: credits Bank/Clearing", () => {
    const lines = buildPurchaseLines(PURCHASE_ACCOUNTS, { total: 300_000, settlementMethod: "bank" });
    expect(lines[1]).toEqual({ accountId: "bank", debit: 0, credit: 300_000 });
  });

  it("returns nothing for a zero-total purchase", () => {
    expect(buildPurchaseLines(PURCHASE_ACCOUNTS, { total: 0, settlementMethod: "credit" })).toEqual([]);
  });
});
