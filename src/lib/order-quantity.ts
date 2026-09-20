/**
 * The one ceiling on a single order line's quantity.
 *
 * It lives here — not as a literal in each caller — because the backend rule
 * (`order-cart.ts` shape validation, `updateOrderItem`) and every quantity
 * stepper that can grow a line (the POS cart, the modifier picker, the waiter
 * panel, the add-items flows) must agree on it. Before this constant existed
 * the server capped at 50 while the UI steppers happily incremented past it,
 * so a cashier could build a line the server would then refuse at submit —
 * the exact "surprise validation at checkout" the POS must never have.
 *
 * The UI uses it to *prevent* the increment; the server still enforces it,
 * because a malformed or malicious client is never trusted.
 */
export const MAX_ORDER_LINE_QUANTITY = 50;

/** Whether `quantity` is a whole count a single order line may carry (1..MAX). */
export function isValidOrderLineQuantity(quantity: unknown): quantity is number {
  return (
    typeof quantity === "number" &&
    Number.isInteger(quantity) &&
    quantity > 0 &&
    quantity <= MAX_ORDER_LINE_QUANTITY
  );
}

/** Clamps a stepper's next value into the legal range without removing the line. */
export function clampOrderLineQuantity(quantity: number): number {
  return Math.min(Math.max(1, Math.round(quantity)), MAX_ORDER_LINE_QUANTITY);
}
