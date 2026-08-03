/**
 * Phase 21 Wave 3 — selling a specific weighed gold piece.
 *
 * Orchestrates, in the caller's own transaction (so a sale is always atomic
 * with its postings and status change, same discipline as every ledger
 * posting path): look up the item's weight/cost basis and today's gold
 * price, compute the price breakdown (src/lib/gold-pricing.ts), post both
 * halves of the sale through the domain-event engine
 * (src/lib/gold-posting-rules.ts — importing it here registers the rules),
 * and mark the piece sold.
 *
 * DB-touching, so per repo convention (see gold-pricing.ts for the pure
 * formula this leans on) it has no direct unit test; covered instead by
 * integration/gold-sales.integration.test.ts.
 */
import type { PoolClient } from "pg";
import { computeGoldSalePrice, type GoldSalePriceBreakdown, type MakingCharge } from "./gold-pricing";
import { getGoldPrice } from "./gold-prices-service";
import { getItem, getWeightAttributes, setWeightItemStatus } from "./items-service";
import { emitDomainEvent } from "./posting-engine";
import type { RialText } from "./inventory-exact";
import type { SettlementMethod } from "./ledger";
// Side-effect import: registers "gold.sale_revenue"/"gold.sale_cogs" with the engine.
import "./gold-posting-rules";

export interface SellWeightedItemInput {
  businessId: string;
  locationId: string;
  itemId: string;
  makingCharge: MakingCharge;
  profitPercent: number;
  vatPercent: number;
  paymentMethod: SettlementMethod;
  createdBy?: string | null;
  /** Defaults to today — the gold-price lookup date, in case a sale is backdated. */
  priceDate?: string;
}

export interface SellWeightedItemResult {
  breakdown: GoldSalePriceBreakdown;
  revenueEntryId: string | null;
  cogsEntryId: string | null;
}

export async function sellWeightedItem(
  client: PoolClient,
  input: SellWeightedItemInput,
): Promise<SellWeightedItemResult> {
  const item = await getItem(input.itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.tracking !== "weight") {
    throw new Error("فقط کالای با ردیابی «وزنی» را می‌توان با این روش فروخت.");
  }

  const weightAttrs = await getWeightAttributes(input.itemId);
  if (!weightAttrs) throw new Error("ویژگی وزن/عیار برای این کالا ثبت نشده است.");
  if (weightAttrs.status !== "in_stock") {
    throw new Error("این کالا در انبار موجود نیست (رزرو شده یا قبلاً فروخته شده است).");
  }
  if (!weightAttrs.unitCostPerGram) {
    throw new Error("بهای تمام‌شده این کالا ثبت نشده است؛ ابتدا آن را ثبت کنید.");
  }

  const price = await getGoldPrice(input.businessId, weightAttrs.purity, input.priceDate);
  if (!price) throw new Error(`قیمت طلای عیار ${weightAttrs.purity} برای امروز ثبت نشده است.`);

  const breakdown = computeGoldSalePrice({
    netWeight: weightAttrs.netWeight,
    pricePerGram: price.pricePerGram,
    makingCharge: input.makingCharge,
    profitPercent: input.profitPercent,
    vatPercent: input.vatPercent,
  });

  const makingChargePlusProfit = (
    BigInt(breakdown.makingCharge) + BigInt(breakdown.profit)
  ).toString() as RialText;

  const { entryId: revenueEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "gold.sale_revenue",
    payload: {
      itemId: input.itemId,
      metalValue: breakdown.metalValue,
      makingChargePlusProfit,
      vat: breakdown.vat,
      total: breakdown.total,
      paymentMethod: input.paymentMethod,
    },
    sourceType: "gold_sale",
    sourceId: input.itemId,
    createdBy: input.createdBy ?? null,
  });

  const { entryId: cogsEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "gold.sale_cogs",
    payload: {
      itemId: input.itemId,
      netWeight: weightAttrs.netWeight,
      unitCostPerGram: weightAttrs.unitCostPerGram,
    },
    sourceType: "gold_sale",
    sourceId: input.itemId,
    createdBy: input.createdBy ?? null,
  });

  await setWeightItemStatus(input.itemId, "sold", client);

  return { breakdown, revenueEntryId, cogsEntryId };
}
