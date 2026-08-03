/**
 * Phase 21 Wave 3 — gold sale posting rules, registered against Wave 1's
 * domain-event/posting engine.
 *
 * Two entries per sale, not one — the same split Phase 7 decided for F&B
 * order payments (revenue recognition vs. cost of the goods sold are
 * conceptually distinct events):
 *
 *   - `gold.sale_revenue`: Debit Cash/Bank-Clearing/Accounts-Receivable
 *     (by payment method) for the total price; Credit `goldSalesRevenue`
 *     for the metal value (VAT-exempt), `makingChargeRevenue` for making
 *     charge + profit combined, and `vatPayable` for VAT — mirroring the
 *     gold-pricing engine's own VAT-on-اجرت-و-سود-only rule
 *     (src/lib/gold-pricing.ts).
 *   - `gold.sale_cogs`: Debit `goldCogs` / Credit `goldInventory` for the
 *     sold piece's cost basis (net weight × unit_cost_per_gram, plus the
 *     sum of any item_stones cost add-ons — Wave 4). Stone costs are read
 *     live from item_stones rather than passed through the event payload,
 *     the same "resolve against the current record, not a caller-supplied
 *     snapshot" instinct accountIdsByCode already uses for account ids.
 */
import Decimal from "decimal.js";
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, roundRial, type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";
import type { SettlementMethod } from "./ledger";

interface GoldSaleRevenuePayload {
  itemId: string;
  metalValue: RialText;
  makingChargePlusProfit: RialText;
  vat: RialText;
  total: RialText;
  paymentMethod: SettlementMethod;
}

const PAYMENT_ACCOUNT_CODE: Record<SettlementMethod, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bankClearing,
  credit: WELL_KNOWN_CODES.accountsReceivable,
};

registerPostingRule("gold.sale_revenue", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as GoldSaleRevenuePayload;
  const paymentCode = PAYMENT_ACCOUNT_CODE[payload.paymentMethod];

  const accounts = await accountIdsByCode(client, event.businessId, [
    paymentCode,
    WELL_KNOWN_CODES.goldSalesRevenue,
    WELL_KNOWN_CODES.makingChargeRevenue,
    WELL_KNOWN_CODES.vatPayable,
  ]);
  const zero = "0" as RialText;

  const lines = [
    { accountId: accounts.get(paymentCode)!, debit: payload.total, credit: zero },
    { accountId: accounts.get(WELL_KNOWN_CODES.goldSalesRevenue)!, debit: zero, credit: payload.metalValue },
    {
      accountId: accounts.get(WELL_KNOWN_CODES.makingChargeRevenue)!,
      debit: zero,
      credit: payload.makingChargePlusProfit,
    },
    { accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: zero, credit: payload.vat },
  ];

  return {
    lines,
    memo: "فروش طلا",
    postingKind: "gold_sale_revenue",
  };
});

interface GoldSaleCogsPayload {
  itemId: string;
  netWeight: string;
  unitCostPerGram: string;
}

registerPostingRule("gold.sale_cogs", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as GoldSaleCogsPayload;
  const metalCost = new Decimal(payload.netWeight).times(payload.unitCostPerGram);

  const { rows: stoneRows } = await client.query<{ total: string | null }>(
    `SELECT SUM(cost)::text AS total FROM item_stones WHERE item_id = $1`,
    [payload.itemId],
  );
  const stoneCost = new Decimal(stoneRows[0]?.total ?? 0);

  const cost = roundRial(metalCost.plus(stoneCost));
  if (rialBigInt(cost) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.goldCogs,
    WELL_KNOWN_CODES.goldInventory,
  ]);
  const zero = "0" as RialText;

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.goldCogs)!, debit: cost, credit: zero },
      { accountId: accounts.get(WELL_KNOWN_CODES.goldInventory)!, debit: zero, credit: cost },
    ],
    memo: "بهای تمام‌شده طلای فروخته‌شده",
    postingKind: "gold_sale_cogs",
  };
});
