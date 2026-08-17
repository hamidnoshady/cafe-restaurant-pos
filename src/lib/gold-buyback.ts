/**
 * Phase 27 Wave 9 — gold buy-back pricing (pure, framework-free).
 *
 * Buying scrap/second-hand gold: the customer's piece is weighed gross, an
 * impurity/کسری deduction (dirt, solder, alloy loss on melting) is applied,
 * and the shop pays the *net* grams at the day's buy rate. The buy rate is a
 * second role on gold_prices (never the sell price), so a shop can never
 * accidentally pay retail for scrap.
 */
import Decimal from "decimal.js";
import { roundRial } from "./inventory-exact";

export interface BuyBackInput {
  /** Gross weight in grams, decimal. */
  grossWeight: string;
  /** Impurity/کسری deduction, percent (0-100). */
  karsorPercent: number;
  /** The day's buy rate per gram, Rial. */
  buyPricePerGram: number;
}

export interface BuyBackResult {
  /** Net payable grams after the deduction, decimal. */
  netWeight: string;
  /** Whole-Rial payable value. */
  valueRial: number;
}

export function validateBuyBackInput(input: BuyBackInput): string[] {
  const errors: string[] = [];
  try {
    if (new Decimal(input.grossWeight).lte(0)) errors.push("وزن ناخالص باید بزرگ‌تر از صفر باشد.");
  } catch {
    errors.push("وزن ناخالص نامعتبر است.");
  }
  if (!Number.isFinite(input.karsorPercent) || input.karsorPercent < 0 || input.karsorPercent > 100) {
    errors.push("کسری باید عددی بین ۰ و ۱۰۰ باشد.");
  }
  if (!Number.isInteger(input.buyPricePerGram) || input.buyPricePerGram <= 0) {
    errors.push("نرخ خرید هر گرم باید یک عدد صحیح مثبت (ریال) باشد.");
  }
  return errors;
}

/** Net grams = gross × (1 − کسری%), payable = net grams × buy rate. */
export function computeBuyBack(input: BuyBackInput): BuyBackResult {
  const gross = new Decimal(input.grossWeight);
  const net = gross.times(100 - input.karsorPercent).div(100);
  const value = roundRial(net.times(input.buyPricePerGram));
  return { netWeight: net.toFixed(), valueRial: Number(value) };
}
