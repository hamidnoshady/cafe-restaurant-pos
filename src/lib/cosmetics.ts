/**
 * Phase 27 Wave 1 — cosmetics & toiletries (آرایشی و بهداشتی): sale price
 * and running-average cost (pure helpers).
 *
 * Cosmetics reuses Phase 21's retail item model exactly as accessories does —
 * `items` (variant_parent/variant_child) + `item_stock` — so the receipt and
 * running-average-cost arithmetic is byte-for-byte the accessories shape.
 * Those two functions are shared (`nextAverageUnitCost`,
 * `validateStockReceipt`) rather than re-implemented; what this module adds is
 * the cosmetics-named sale-price path and a pack→unit price helper, both on
 * the exact (Decimal/RialText) path every posting this phase builds runs on.
 */
import Decimal from "decimal.js";
import { rialBigInt, rialText, roundRial, type RialText } from "./inventory-exact";
import { nextAverageUnitCost, validateStockReceipt } from "./accessories";

export { nextAverageUnitCost, validateStockReceipt };

/**
 * Price per unit when a product is sold by the pack (e.g. a box of 6 units of
 * shampoo at one pack price). Rounded to the whole Rial, so a receipt's lines
 * always sum to its total.
 */
export function unitPriceFromPack(packPrice: number, unitsPerPack: number): RialText {
  if (!Number.isInteger(packPrice) || packPrice <= 0) {
    throw new Error("قیمت بسته باید یک عدد صحیح مثبت (ریال) باشد.");
  }
  if (!Number.isInteger(unitsPerPack) || unitsPerPack <= 0) {
    throw new Error("تعداد واحد در هر بسته باید یک عدد صحیح مثبت باشد.");
  }
  return roundRial(new Decimal(packPrice).div(unitsPerPack));
}

export interface CosmeticSalePriceInput {
  /** Shelf price per unit (Rial, whole, pre-VAT). */
  unitPrice: number;
  /** Units sold. */
  quantity: string;
  /** A discount off the line total (Rial, whole) — 0 for none. */
  discount?: number;
  /** 0-100. */
  vatPercent: number;
}

export interface CosmeticSalePriceBreakdown {
  gross: RialText;
  discount: RialText;
  net: RialText;
  vat: RialText;
  total: RialText;
}

export function validateCosmeticSalePriceInput(input: CosmeticSalePriceInput): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(input.unitPrice) || input.unitPrice <= 0) {
    errors.push("قیمت فروش هر واحد باید یک عدد صحیح مثبت (ریال) باشد.");
  }
  try {
    if (new Decimal(input.quantity).lte(0)) errors.push("تعداد فروش باید بزرگ‌تر از صفر باشد.");
  } catch {
    errors.push("تعداد فروش نامعتبر است.");
  }
  const discount = input.discount ?? 0;
  if (!Number.isInteger(discount) || discount < 0) {
    errors.push("تخفیف باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }
  if (!Number.isFinite(input.vatPercent) || input.vatPercent < 0 || input.vatPercent > 100) {
    errors.push("درصد مالیات باید بین ۰ تا ۱۰۰ باشد.");
  }
  return errors;
}

/** Every component is rounded to whole Rial as it is computed, each stage building on the previous stage's rounded value — the same rule that keeps a receipt's lines summing to its total. */
export function computeCosmeticSalePrice(input: CosmeticSalePriceInput): CosmeticSalePriceBreakdown {
  const errors = validateCosmeticSalePriceInput(input);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  const gross = roundRial(new Decimal(input.quantity).times(input.unitPrice));
  const discount = rialText(String(input.discount ?? 0));
  if (rialBigInt(discount) > rialBigInt(gross)) {
    throw new Error("تخفیف نمی‌تواند از مبلغ کل بیشتر باشد.");
  }
  const net = rialText((rialBigInt(gross) - rialBigInt(discount)).toString());
  const vat = roundRial(new Decimal(net).times(input.vatPercent).div(100));
  const total = rialText((rialBigInt(net) + rialBigInt(vat)).toString());

  return { gross, discount, net, vat, total };
}

/** The cost of goods sold for `quantity` units carried at `unitCost` — the COGS side of the same sale. */
export function cosmeticCogs(quantity: string, unitCost: number): RialText {
  return roundRial(new Decimal(quantity).times(unitCost));
}
