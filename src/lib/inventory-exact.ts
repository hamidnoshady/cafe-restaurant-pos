import Decimal from "decimal.js";
import {
  isCanonicalUnsignedDecimalText,
  isCanonicalUnsignedIntegerText,
} from "./numeric-validation";

Decimal.set({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -80,
  toExpPos: 80,
});

export type QuantityText = string & { readonly __quantityText: unique symbol };
export type UnitCostText = string & { readonly __unitCostText: unique symbol };
export type RialText = string & { readonly __rialText: unique symbol };

function canonicalDecimal(input: string, maximumScale: number, field: string): string {
  if (typeof input !== "string" || !isCanonicalUnsignedDecimalText(input)) throw new Error(`invalid_${field}`);
  const canonical = input.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  const clean = canonical === "" ? "0" : canonical;
  const scale = clean.includes(".") ? clean.length - clean.indexOf(".") - 1 : 0;
  if (scale > maximumScale) throw new Error(`${field}_precision_exceeded`);
  return clean;
}

export function quantityText(input: string): QuantityText {
  return canonicalDecimal(input, 9, "quantity") as QuantityText;
}

export function positiveQuantityText(input: string): QuantityText {
  const value = quantityText(input);
  if (new Decimal(value).lte(0)) throw new Error("invalid_quantity");
  return value;
}

export function unitCostText(input: string): UnitCostText {
  return canonicalDecimal(input, 24, "unit_cost") as UnitCostText;
}

export function rialText(input: string): RialText {
  if (typeof input !== "string" || !isCanonicalUnsignedIntegerText(input)) throw new Error("invalid_rial");
  return BigInt(input).toString() as RialText;
}

export function rialBigInt(input: RialText): bigint {
  return BigInt(input);
}

/** The largest value a Postgres `bigint` Rial column can hold. */
export const MAX_RIAL = 9223372036854775807n;

/**
 * `rialText` that also refuses what the storage cannot hold.
 *
 * Rial amounts land in `bigint` columns, so a value above 2^63-1 is not a
 * large number — it is an INSERT that aborts the transaction with `value
 * "…" is out of range for type bigint`, i.e. a 500 for what is really a
 * caller error (a mistyped unit cost with a dozen extra zeroes). Validate it
 * where the value is parsed, so the answer is a clean 400 instead.
 */
export function boundedRialText(input: string): RialText {
  const value = rialText(input);
  if (BigInt(value) > MAX_RIAL) throw new Error("rial_out_of_range");
  return value;
}

export function addQuantity(left: QuantityText, right: QuantityText): QuantityText {
  return quantityText(new Decimal(left).plus(new Decimal(right)).toFixed());
}

export function subtractQuantity(left: QuantityText, right: QuantityText): QuantityText {
  const result = new Decimal(left).minus(new Decimal(right));
  if (result.isNegative()) throw new Error("quantity_underflow");
  return quantityText(result.toFixed());
}

export function minQuantity(left: QuantityText, right: QuantityText): QuantityText {
  return new Decimal(left).lte(new Decimal(right)) ? left : right;
}

export function multiplyExact(quantity: QuantityText, unitCost: UnitCostText): Decimal {
  return new Decimal(quantity).times(new Decimal(unitCost));
}

export function roundRial(value: Decimal): RialText {
  if (value.isNegative()) throw new Error("invalid_rial");
  return rialText(value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

export interface RialAllocationInput {
  key: string;
  weight: QuantityText;
}

/**
 * Allocates an already-rounded whole-Rial total by exact decimal weights.
 * Floors every share, then assigns residual Rial by descending fractional
 * remainder and stable input order. The returned values always conserve the
 * supplied total, including values above Number.MAX_SAFE_INTEGER.
 */
export function allocateRialByWeight(total: RialText, inputs: RialAllocationInput[]): Map<string, RialText> {
  if (inputs.length === 0) {
    if (rialBigInt(total) !== 0n) throw new Error("allocation_requires_inputs");
    return new Map();
  }
  const weights = inputs.map((input, index) => ({
    ...input,
    index,
    decimal: new Decimal(input.weight),
  }));
  const weightTotal = weights.reduce((sum, input) => sum.plus(input.decimal), new Decimal("0"));
  if (weightTotal.lte(0)) throw new Error("allocation_weight_required");

  const totalDecimal = new Decimal(total);
  const shares = weights.map((input) => {
    const exact = totalDecimal.times(input.decimal).div(weightTotal);
    const floor = exact.toDecimalPlaces(0, Decimal.ROUND_FLOOR);
    return { ...input, floor, remainder: exact.minus(floor) };
  });
  let residual =
    rialBigInt(total) - shares.reduce((sum, share) => sum + BigInt(share.floor.toFixed(0)), 0n);
  const ranked = [...shares].sort((a, b) => {
    const remainderOrder = b.remainder.comparedTo(a.remainder);
    return remainderOrder === 0 ? a.index - b.index : remainderOrder;
  });
  const values = new Map(shares.map((share) => [share.key, BigInt(share.floor.toFixed(0))]));
  for (let index = 0; residual > 0n; index = (index + 1) % ranked.length) {
    const key = ranked[index].key;
    values.set(key, values.get(key)! + 1n);
    residual--;
  }
  return new Map([...values].map(([key, value]) => [key, rialText(value.toString())]));
}

export function proportionalDepletionValue(
  remainingQuantity: QuantityText,
  remainingValue: RialText,
  depletedQuantity: QuantityText,
): RialText {
  const remaining = new Decimal(remainingQuantity);
  const depleted = new Decimal(depletedQuantity);
  if (depleted.gt(remaining)) throw new Error("quantity_underflow");
  if (depleted.eq(remaining)) return remainingValue;
  return roundRial(new Decimal(remainingValue).times(depleted).div(remaining));
}
