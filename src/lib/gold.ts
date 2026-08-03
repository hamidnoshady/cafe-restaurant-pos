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
