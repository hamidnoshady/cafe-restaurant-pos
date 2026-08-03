/**
 * Phase 21 Wave 3 — the gold pricing engine (pure).
 *
 * قیمت نهایی = ارزش فلز + اجرت + سود + مالیات، where:
 *   - ارزش فلز (metal value) = net weight × price/gram for the item's purity.
 *   - اجرت (making charge) is a percent of the metal value, or a flat Rial
 *     amount — the business's choice per item.
 *   - سود (profit) is a percent of (metal value + making charge).
 *   - مالیات (VAT) applies only to (making charge + profit), NOT the metal
 *     value — metal value is VAT-exempt under Iranian tax practice for gold
 *     jewelry (decided explicitly with the product owner, not assumed).
 *
 * Every component is rounded to whole Rial as it's computed (not just the
 * final total), each stage building on the previous stage's *rounded*
 * value — so a receipt's line items always sum to exactly the displayed
 * total, with no hidden unrounded precision a customer can't see.
 */
import Decimal from "decimal.js";
import { rialBigInt, rialText, roundRial, type RialText } from "./inventory-exact";

export type MakingChargeType = "percent" | "fixed";

export interface MakingCharge {
  type: MakingChargeType;
  /** percent: 0-100 (e.g. 7 for 7%); fixed: a whole-Rial amount. */
  value: number;
}

export interface GoldSalePriceInput {
  /** Grams — item_weight_attributes.net_weight. */
  netWeight: string;
  /** Rial per gram, for this item's purity — gold_prices.price_per_gram. */
  pricePerGram: number;
  makingCharge: MakingCharge;
  /** 0-100. */
  profitPercent: number;
  /** 0-100. */
  vatPercent: number;
}

export interface GoldSalePriceBreakdown {
  metalValue: RialText;
  makingCharge: RialText;
  profit: RialText;
  vat: RialText;
  total: RialText;
}

/** Mirrors the shape every field's own storage type enforces — a bad request is rejected before any computation happens. */
export function validateGoldSalePriceInput(input: GoldSalePriceInput): string[] {
  const errors: string[] = [];

  try {
    if (new Decimal(input.netWeight).lte(0)) errors.push("وزن باید بزرگ‌تر از صفر باشد.");
  } catch {
    errors.push("وزن نامعتبر است.");
  }

  if (!Number.isInteger(input.pricePerGram) || input.pricePerGram <= 0) {
    errors.push("قیمت هر گرم باید یک عدد صحیح مثبت (ریال) باشد.");
  }

  if (input.makingCharge.type === "percent") {
    if (input.makingCharge.value < 0 || input.makingCharge.value > 100) {
      errors.push("درصد اجرت باید بین ۰ تا ۱۰۰ باشد.");
    }
  } else if (input.makingCharge.value < 0) {
    errors.push("مبلغ اجرت نمی‌تواند منفی باشد.");
  }

  if (input.profitPercent < 0 || input.profitPercent > 100) {
    errors.push("درصد سود باید بین ۰ تا ۱۰۰ باشد.");
  }
  if (input.vatPercent < 0 || input.vatPercent > 100) {
    errors.push("درصد مالیات باید بین ۰ تا ۱۰۰ باشد.");
  }

  return errors;
}

export function computeGoldSalePrice(input: GoldSalePriceInput): GoldSalePriceBreakdown {
  const errors = validateGoldSalePriceInput(input);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  const metalValue = roundRial(new Decimal(input.netWeight).times(input.pricePerGram));
  const metalValueDecimal = new Decimal(metalValue);

  const makingChargeDecimal =
    input.makingCharge.type === "percent"
      ? metalValueDecimal.times(input.makingCharge.value).div(100)
      : new Decimal(input.makingCharge.value);
  const makingCharge = roundRial(makingChargeDecimal);
  const makingChargeRounded = new Decimal(makingCharge);

  const profitDecimal = metalValueDecimal.plus(makingChargeRounded).times(input.profitPercent).div(100);
  const profit = roundRial(profitDecimal);
  const profitRounded = new Decimal(profit);

  const vatDecimal = makingChargeRounded.plus(profitRounded).times(input.vatPercent).div(100);
  const vat = roundRial(vatDecimal);

  const total = rialText(
    (rialBigInt(metalValue) + rialBigInt(makingCharge) + rialBigInt(profit) + rialBigInt(vat)).toString(),
  );

  return { metalValue, makingCharge, profit, vat, total };
}
