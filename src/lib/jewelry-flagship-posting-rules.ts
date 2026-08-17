/**
 * Phase 27 Wave 9 — jewelry flagship posting rules.
 *
 *   - buy-back:        Debit goldInventory / Credit cash (the shop buys scrap)
 *   - layaway deposit: Debit cash / Credit customer-deposit liability
 *   - layaway complete: Debit customer-deposit liability / Credit gold revenue
 *   - gold account:    a positive movement (customer gives gold) debits gold
 *     inventory and credits the customer's gold liability; a negative movement
 *     (withdrawal) reverses it. The sign of `valueRial` picks the direction.
 *   - custom order:    the deposit debits cash / credits the deposit liability.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, rialText, type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";

const ZERO = "0" as RialText;

interface AmountPayload {
  amount: RialText;
}

registerPostingRule("jewelry.gold_buy_back", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as AmountPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.goldInventory,
    WELL_KNOWN_CODES.cash,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.goldInventory)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.cash)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "خرید طلای دست‌دوم و آبشده",
    postingKind: "gold_buy_back",
  };
});

registerPostingRule("jewelry.layaway_deposit", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as AmountPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.layawayDeposit,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.cash)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.layawayDeposit)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "پیش‌دریافت لیاوی",
    postingKind: "layaway_deposit",
  };
});

registerPostingRule("jewelry.layaway_completed", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as AmountPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.layawayDeposit,
    WELL_KNOWN_CODES.goldSalesRevenue,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.layawayDeposit)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.goldSalesRevenue)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "تکمیل لیاوی",
    postingKind: "layaway_completed",
  };
});

interface GoldAccountMovementPayload {
  /** Signed Rial value: positive = customer deposited gold, negative = withdrew. */
  valueRial: string;
}

registerPostingRule("jewelry.gold_account_movement", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as GoldAccountMovementPayload;
  // Signed — the brand RialText is non-negative by construction, so parse the
  // raw string with BigInt rather than through rialBigInt.
  const value = BigInt(payload.valueRial);
  if (value === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.goldInventory,
    WELL_KNOWN_CODES.goldCustomerAccount,
  ]);
  const amount = rialText((value < 0n ? -value : value).toString());

  const inventory = accounts.get(WELL_KNOWN_CODES.goldInventory)!;
  const customer = accounts.get(WELL_KNOWN_CODES.goldCustomerAccount)!;

  const lines =
    value > 0n
      ? [
          { accountId: inventory, debit: amount, credit: ZERO },
          { accountId: customer, debit: ZERO, credit: amount },
        ]
      : [
          { accountId: customer, debit: amount, credit: ZERO },
          { accountId: inventory, debit: ZERO, credit: amount },
        ];

  return { lines, memo: "گردش حساب طلایی مشتری", postingKind: "gold_account_movement" };
});

registerPostingRule("jewelry.custom_order_deposit", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as AmountPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.layawayDeposit,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.cash)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.layawayDeposit)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "پیش‌دریافت سفارش ساخت",
    postingKind: "custom_order_deposit",
  };
});
