import Decimal from "decimal.js";
import { rialText, type RialText } from "./inventory-exact";
import { validCommissionPercent } from "./online-platforms";

/**
 * Resolve a percentage against a whole-Rial amount without converting the
 * amount to Number. Rials can exceed Number.MAX_SAFE_INTEGER, and a Number
 * calculation can silently move a commission by several Rials on a large
 * order. Decimal also gives the contract's decimal rate HALF_UP rounding.
 */
export function commissionAmountFor(amount: RialText, commissionPercent: number): RialText {
  if (!validCommissionPercent(commissionPercent)) throw new Error("invalid_commission_percent");
  return rialText(
    new Decimal(amount)
      .times(new Decimal(String(commissionPercent)))
      .div(100)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toFixed(0),
  );
}
