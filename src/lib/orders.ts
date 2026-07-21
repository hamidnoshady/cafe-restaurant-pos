/**
 * Order total calculations — pure functions, integer Rial in/out.
 *
 * Discount is applied at the order level (percent or fixed amount off the
 * subtotal), then distributed across lines proportionally so each line's
 * tax is computed on its own category's tax_rate against its
 * post-discount share. The last line absorbs any rounding remainder so
 * sum(line discounts) === order discount exactly.
 */
import type { Rial } from "./money";

export interface CartLine {
  /** menu item price at time of sale, Rial */
  unitPrice: Rial;
  quantity: number;
  /** per-unit modifier price deltas, Rial (may be negative) */
  modifierDeltas: Rial[];
  /** the menu item's category tax rate, percent (0-100) */
  taxRatePercent: number;
}

export type DiscountInput = { type: "percent" | "amount"; value: number } | { type: null; value?: number };

export interface LineTotal {
  lineSubtotal: Rial;
  lineDiscount: Rial;
  lineTax: Rial;
  lineTotal: Rial;
}

export interface OrderTotals {
  subtotal: Rial;
  discount: Rial;
  tax: Rial;
  total: Rial;
  lines: LineTotal[];
}

export function computeLineSubtotal(line: Pick<CartLine, "unitPrice" | "quantity" | "modifierDeltas">): Rial {
  const modSum = line.modifierDeltas.reduce((a, b) => a + b, 0);
  return (line.unitPrice + modSum) * line.quantity;
}

/** Clamped to [0, subtotal]; percent clamped to [0, 100]. */
export function computeDiscountAmount(subtotal: Rial, discount: DiscountInput): Rial {
  if (!discount.type || subtotal <= 0) return 0;
  if (discount.type === "percent") {
    const pct = Math.min(Math.max(discount.value, 0), 100);
    return Math.round((subtotal * pct) / 100);
  }
  return Math.min(Math.max(Math.round(discount.value), 0), subtotal);
}

export function computeOrderTotals(
  lines: CartLine[],
  discount: DiscountInput,
  serviceCharge: Rial = 0,
): OrderTotals {
  const lineSubtotals = lines.map(computeLineSubtotal);
  const subtotal = lineSubtotals.reduce((a, b) => a + b, 0);
  const discountAmount = computeDiscountAmount(subtotal, discount);

  let allocatedDiscount = 0;
  const lineResults: LineTotal[] = lines.map((line, i) => {
    const lineSubtotal = lineSubtotals[i];
    const isLast = i === lines.length - 1;
    const share = subtotal > 0 ? lineSubtotal / subtotal : 0;
    const lineDiscount = isLast ? discountAmount - allocatedDiscount : Math.round(discountAmount * share);
    allocatedDiscount += lineDiscount;
    const taxableBase = lineSubtotal - lineDiscount;
    const lineTax = Math.round((taxableBase * line.taxRatePercent) / 100);
    return { lineSubtotal, lineDiscount, lineTax, lineTotal: taxableBase + lineTax };
  });

  const tax = lineResults.reduce((a, l) => a + l.lineTax, 0);
  const total = subtotal - discountAmount + tax + serviceCharge;
  return { subtotal, discount: discountAmount, tax, total, lines: lineResults };
}

/** Cashier-facing queue/order label. Takeaway orders get a "T-" prefix. */
export function formatQueueLabel(type: "dine_in" | "takeaway" | "delivery", orderNumber: number): string {
  return type === "takeaway" ? `T-${orderNumber}` : `#${orderNumber}`;
}
