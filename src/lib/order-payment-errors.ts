import { fiscalPeriodLockErrorCode } from "./fiscal-periods";

/**
 * The known ways checkout can refuse an order, recovered from a thrown error.
 *
 * POST /api/orders/[id]/pay does its work inside one transaction, and until
 * now it caught exactly one failure by type (MissingLedgerAccountError).
 * Everything else — a locked fiscal period, an ingredient requirement that goes
 * negative, a costing constraint — escaped as a 500, which the dashboard renders
 * with its catch-all "خطای غیرمنتظره. دوباره تلاش کنید.". That message is a dead
 * end for the person holding the card reader: it names nothing to fix, and
 * retrying can never help because every one of these is deterministic.
 *
 * Each code here has a message in dashboard/ui.tsx, so the cashier is told which
 * thing to go and change.
 */
export interface PaymentFailure {
  error: string;
  status: number;
}

/**
 * Costing invariants that a sale can trip. Both are about the *value* side of a
 * stock movement rather than the sale itself, so they mean "this branch's
 * ingredient costs are inconsistent", not "this order is malformed" — hence one
 * shared code rather than one per constraint.
 */
const COSTING_CONSTRAINTS = new Set([
  "negative_layer_exact_value_bounds",
  "inventory_lot_exact_value_bounds",
]);

/** A check-constraint violation (23514) names the constraint it broke. */
function violatedConstraint(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  if (code !== "23514" || typeof constraint !== "string") return null;
  return constraint;
}

/**
 * Translates a checkout failure into an error code the UI can explain, or null
 * when the error is genuinely unexpected and should stay a 500 — swallowing an
 * unknown fault into a tidy 409 would hide the next bug of this kind.
 */
export function paymentFailureFor(err: unknown): PaymentFailure | null {
  const lockCode = fiscalPeriodLockErrorCode(err);
  if (lockCode) return { error: lockCode, status: 409 };

  if (err instanceof Error && err.message === "negative_ingredient_requirement") {
    return { error: "negative_ingredient_requirement", status: 409 };
  }

  const constraint = violatedConstraint(err);
  if (constraint && COSTING_CONSTRAINTS.has(constraint)) {
    return { error: "inventory_costing_conflict", status: 409 };
  }

  return null;
}
