/**
 * Phase 21 Wave 2 — weighted goods & gold inventory (pure helpers).
 *
 * Purity is a controlled list, not free text at the validation layer, even
 * though the DB column itself is a plain `text` (so a later purity — a new
 * coin denomination, say — is a data change, not a migration). Coin
 * ("سکه") purities are deliberately not in this list yet: a coin is priced
 * per unit, not per gram, which doesn't fit `gold_prices.price_per_gram` —
 * that's a distinct pricing shape left for a later wave, not guessed at
 * here.
 */
import Decimal from "decimal.js";

export const PURITIES = ["18", "21", "24"] as const;
export type Purity = (typeof PURITIES)[number];

export function isPurity(value: string): value is Purity {
  return (PURITIES as readonly string[]).includes(value);
}

export interface WeightAttributesInput {
  purity: string;
  grossWeight: string;
  netWeight: string;
  /** What the business paid per gram for this specific piece — omit until the cost basis is known (e.g. mid-intake); the sale path refuses to sell an item with none set. */
  unitCostPerGram?: string | null;
}

/** Mirrors item_weight_attributes' own CHECK constraints, so a bad request is rejected before it ever reaches the database. */
export function validateWeightAttributes(input: WeightAttributesInput): string[] {
  const errors: string[] = [];
  if (!isPurity(input.purity)) {
    errors.push(`عیار «${input.purity}» نامعتبر است.`);
  }

  let gross: Decimal | null = null;
  let net: Decimal | null = null;
  try {
    gross = new Decimal(input.grossWeight);
    if (gross.lte(0)) {
      errors.push("وزن ناخالص باید بزرگ‌تر از صفر باشد.");
      gross = null;
    }
  } catch {
    errors.push("وزن ناخالص نامعتبر است.");
  }
  try {
    net = new Decimal(input.netWeight);
    if (net.lte(0)) {
      errors.push("وزن خالص باید بزرگ‌تر از صفر باشد.");
      net = null;
    }
  } catch {
    errors.push("وزن خالص نامعتبر است.");
  }

  if (gross && net && net.gt(gross)) {
    errors.push("وزن خالص نمی‌تواند از وزن ناخالص بیشتر باشد.");
  }

  if (input.unitCostPerGram != null) {
    try {
      if (new Decimal(input.unitCostPerGram).lte(0)) {
        errors.push("بهای تمام‌شده هر گرم باید بزرگ‌تر از صفر باشد.");
      }
    } catch {
      errors.push("بهای تمام‌شده هر گرم نامعتبر است.");
    }
  }

  return errors;
}

/** Mirrors gold_prices' own CHECK constraint. */
export function validateGoldPrice(purity: string, pricePerGram: number): string[] {
  const errors: string[] = [];
  if (!isPurity(purity)) errors.push(`عیار «${purity}» نامعتبر است.`);
  if (!Number.isInteger(pricePerGram) || pricePerGram <= 0) {
    errors.push("قیمت هر گرم باید یک عدد صحیح مثبت (ریال) باشد.");
  }
  return errors;
}

export interface StoneInput {
  stoneType: string;
  carat: string;
  /** What the business paid for this specific stone (Rial, whole number) — adds to the item's COGS at sale time. */
  cost: number;
}

/** Mirrors item_stones' own CHECK constraints. stoneType is free text (unlike purity) — gem types vary far more than gold's fixed karat scale, so a controlled list would just get in the way. */
export function validateStone(input: StoneInput): string[] {
  const errors: string[] = [];
  if (!input.stoneType?.trim()) errors.push("نوع سنگ نمی‌تواند خالی باشد.");

  try {
    if (new Decimal(input.carat).lte(0)) errors.push("وزن سنگ (قیراط) باید بزرگ‌تر از صفر باشد.");
  } catch {
    errors.push("وزن سنگ (قیراط) نامعتبر است.");
  }

  if (!Number.isInteger(input.cost) || input.cost <= 0) {
    errors.push("بهای سنگ باید یک عدد صحیح مثبت (ریال) باشد.");
  }

  return errors;
}
