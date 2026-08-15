/**
 * Presentation rules for item add-ons (modifiers).
 *
 * An add-on carries its own money — `price_delta`, integer Rial like every
 * other amount in this codebase — and that money is part of what the customer
 * actually pays. Every surface that shows an order line (the POS cart, the
 * review dialog, the open-orders panel, the order page) therefore shows an
 * add-on's *name and its price*, not a bare comma-joined list of names. These
 * helpers are the one place that decides how that price reads, so the cashier
 * sees the same wording everywhere.
 */
import { toPersianDigits } from "./digits";
import { formatToman } from "./money";

/** The minimum an add-on needs to be rendered: what it is and what it costs. */
export interface DisplayModifier {
  name: string;
  /** Integer Rial, may be negative (a discount-shaped add-on). */
  priceDelta: number;
}

/**
 * A priced add-on always carries an explicit sign so «+۲۰٬۰۰۰ تومان» can never
 * be misread as the line's own price; a free one says so in words rather than
 * showing «۰ تومان», which reads like a pricing bug.
 */
export function formatModifierDelta(
  priceDelta: number,
  opts: { withUnit?: boolean } = {},
): string {
  const { withUnit = true } = opts;
  if (priceDelta === 0) return "رایگان";
  const sign = priceDelta > 0 ? "+" : "−";
  return sign + formatToman(Math.abs(priceDelta), { withUnit });
}

export function sumModifierDeltas(deltas: number[]): number {
  return deltas.reduce((sum, delta) => sum + delta, 0);
}

/** Names only — for the thermal ticket/receipt templates, which have no room for chips. */
export function modifierNamesLabel(modifiers: DisplayModifier[]): string {
  return modifiers.map((modifier) => modifier.name).join("، ");
}

export interface LinePriceBreakdown {
  /** The menu price of one unit, before add-ons. */
  base: number;
  /** Total add-on delta for one unit. */
  addOns: number;
  /** base + addOns — what one unit of this exact configuration costs. */
  unit: number;
  /** unit × quantity — what the line contributes to the subtotal. */
  total: number;
}

/**
 * Splits a cart/order line into the numbers a cashier is asked about: the menu
 * price, what the add-ons added, and the resulting unit and line price. Keeping
 * this in one function is what stops a surface from quietly showing a line total
 * that excludes its add-ons.
 */
export function linePriceBreakdown(input: {
  unitPrice: number;
  modifierDeltas: number[];
  quantity: number;
}): LinePriceBreakdown {
  const addOns = sumModifierDeltas(input.modifierDeltas);
  const unit = input.unitPrice + addOns;
  return {
    base: input.unitPrice,
    addOns,
    unit,
    total: unit * input.quantity,
  };
}

/**
 * How a modifier group's [min_select, max_select] bounds read to the person
 * picking. The bounds themselves are validated in modifier-selection.ts; this
 * only phrases them, and phrases the two ends the same way the picker enforces
 * them (min > 0 means the group cannot be skipped).
 */
export function modifierGroupRuleLabel(
  minSelect: number,
  maxSelect: number,
): string {
  const required = minSelect > 0;
  const prefix = required ? "الزامی" : "اختیاری";
  if (minSelect === maxSelect) {
    return `${prefix} · ${toPersianDigits(maxSelect)} مورد`;
  }
  if (!required) {
    return `${prefix} · تا ${toPersianDigits(maxSelect)} مورد`;
  }
  return `${prefix} · ${toPersianDigits(minSelect)} تا ${toPersianDigits(maxSelect)} مورد`;
}

/** «۱ از ۲ انتخاب شد» — the live counter next to a group's title. */
export function modifierGroupProgressLabel(
  selectedCount: number,
  maxSelect: number,
): string {
  return `${toPersianDigits(selectedCount)} از ${toPersianDigits(maxSelect)} انتخاب شد`;
}

/** A group is satisfied when its selected count sits inside its own bounds. */
export function isModifierGroupSatisfied(
  selectedCount: number,
  minSelect: number,
  maxSelect: number,
): boolean {
  return selectedCount >= minSelect && selectedCount <= maxSelect;
}
