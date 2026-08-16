/**
 * Closed-order amendments — the framework-free half.
 *
 * Correcting an order that has already been paid for is "reverse, then
 * replay": everything the checkout posted is undone at its own recorded
 * values, and (for an edit rather than a removal) the corrected order is
 * posted again in its place. The DB-touching orchestration of that lives in
 * order-amendment-service.ts; what lives here is the part that is pure and
 * therefore directly testable — validating the request, turning a *desired*
 * set of lines into the add/update/void plan that gets the order there, and
 * working out which payment rows make the till agree with the new bill.
 */

export const AMENDMENT_KINDS = ["edit", "void"] as const;
export type AmendmentKind = (typeof AMENDMENT_KINDS)[number];

export const AMENDMENT_PAYMENT_METHODS = [
  "cash",
  "card",
  "card_to_card",
  "online",
  "credit",
  "snappfood",
] as const;
export type AmendmentPaymentMethod = (typeof AMENDMENT_PAYMENT_METHODS)[number];

/** Same ceiling the open-order item routes enforce, so an amendment can't smuggle in a line the POS would refuse. */
export const MAX_LINE_QUANTITY = 50;
export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 500;

export interface AmendmentLineInput {
  /** an existing line of the order, kept (possibly re-quantified) */
  orderItemId?: string | null;
  /** a line being added by the amendment; required when orderItemId is absent */
  menuItemId?: string | null;
  quantity?: number | null;
  note?: string | null;
  modifierIds?: string[] | null;
}

export interface AmendmentInput {
  kind: AmendmentKind;
  reason?: string | null;
  /** the complete desired set of lines — anything omitted is voided. Ignored for kind 'void'. */
  lines?: AmendmentLineInput[] | null;
  discount?: { type?: "percent" | "amount" | null; value?: number | null } | null;
  note?: string | null;
  tipAmount?: number | null;
  /** re-settle the corrected bill through this method; defaults to how it was originally paid. */
  paymentMethod?: string | null;
  reference?: string | null;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ValidatedAmendment {
  kind: AmendmentKind;
  reason: string;
  lines: AmendmentLineInput[];
  discount: { type: "percent" | "amount" | null; value: number };
  note: string | null | undefined;
  tipAmount: number | null;
  paymentMethod: AmendmentPaymentMethod | null;
  reference: string | null;
}

/**
 * A reason is mandatory for both kinds. Unlike voiding an *open* order — a
 * mistake at the till nobody has paid for yet — amending a closed one moves
 * money that has already been counted, so "why" is part of the record rather
 * than a nicety.
 */
export function validateAmendment(input: AmendmentInput): Validated<ValidatedAmendment> {
  if (!(AMENDMENT_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, error: "invalid_amendment_kind" };
  }
  const reason = (input.reason ?? "").trim();
  if (reason.length < MIN_REASON_LENGTH) return { ok: false, error: "reason_required" };
  if (reason.length > MAX_REASON_LENGTH) return { ok: false, error: "reason_too_long" };

  const lines = input.kind === "void" ? [] : (input.lines ?? []);
  if (input.kind === "edit") {
    if (lines.length === 0) return { ok: false, error: "no_items" };
    for (const line of lines) {
      const quantity = Number(line.quantity ?? 0);
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_LINE_QUANTITY) {
        return { ok: false, error: "invalid_item" };
      }
      if (!line.orderItemId && !line.menuItemId) return { ok: false, error: "invalid_item" };
    }
  }

  const discountType =
    input.discount?.type === "percent" || input.discount?.type === "amount" ? input.discount.type : null;
  const discountValue = Number(input.discount?.value ?? 0);
  if (discountType) {
    if (!Number.isFinite(discountValue) || discountValue < 0) return { ok: false, error: "invalid_discount" };
    if (discountType === "percent" && discountValue > 100) return { ok: false, error: "invalid_discount" };
  }

  const tipAmount = input.tipAmount === undefined || input.tipAmount === null ? null : Number(input.tipAmount);
  if (tipAmount !== null && (!Number.isSafeInteger(tipAmount) || tipAmount < 0)) {
    return { ok: false, error: "invalid_tip_amount" };
  }

  const method = input.paymentMethod ?? null;
  if (method !== null && !(AMENDMENT_PAYMENT_METHODS as readonly string[]).includes(method)) {
    return { ok: false, error: "invalid_payment_method" };
  }

  return {
    ok: true,
    value: {
      kind: input.kind,
      reason,
      lines,
      discount: { type: discountType, value: discountType ? discountValue : 0 },
      note: input.note,
      tipAmount,
      paymentMethod: method as AmendmentPaymentMethod | null,
      reference: input.reference?.trim() || null,
    },
  };
}

export interface CurrentOrderLine {
  id: string;
  quantity: number;
}

export interface LinePlan {
  /** existing lines that stay, at the quantity/note the amendment asks for */
  updates: { orderItemId: string; quantity: number; note: string | null | undefined }[];
  /** existing lines the amendment dropped */
  voids: string[];
  additions: { menuItemId: string; quantity: number; note: string | null; modifierIds: string[] }[];
}

/**
 * Turns the *desired* set of lines into the mutation plan that gets the order
 * there. The request describes the bill as it should now read, not a sequence
 * of edits, so anything the caller left out is a line being removed — the same
 * whole-document shape editStockCount takes for a posted count.
 */
export function planOrderLines(
  current: CurrentOrderLine[],
  desired: AmendmentLineInput[],
): Validated<LinePlan> {
  const currentIds = new Set(current.map((line) => line.id));
  const seen = new Set<string>();
  const plan: LinePlan = { updates: [], voids: [], additions: [] };

  for (const line of desired) {
    const quantity = Number(line.quantity ?? 0);
    if (line.orderItemId) {
      if (!currentIds.has(line.orderItemId)) return { ok: false, error: "item_not_found" };
      if (seen.has(line.orderItemId)) return { ok: false, error: "duplicate_item" };
      seen.add(line.orderItemId);
      plan.updates.push({ orderItemId: line.orderItemId, quantity, note: line.note });
      continue;
    }
    if (!line.menuItemId) return { ok: false, error: "invalid_item" };
    plan.additions.push({
      menuItemId: line.menuItemId,
      quantity,
      note: line.note?.trim() || null,
      modifierIds: line.modifierIds ?? [],
    });
  }

  for (const line of current) {
    if (!seen.has(line.id)) plan.voids.push(line.id);
  }
  if (plan.updates.length === 0 && plan.additions.length === 0) return { ok: false, error: "no_items" };
  return { ok: true, value: plan };
}

export interface PaymentRow {
  method: AmendmentPaymentMethod;
  amount: number;
}

/**
 * The payment rows an amendment writes: one negative row per method that
 * currently carries a balance on the order, then — for an edit — one row for
 * the corrected bill.
 *
 * `payments` is an event log, so nothing is deleted or rewritten: the original
 * receipt, its reversal and the re-settlement all stay, and the *sum* per
 * method is what the till and the shift reconciliation read. A removal leaves
 * that sum at zero; an edit leaves it at the new total.
 */
export function planPaymentRows(
  paid: PaymentRow[],
  newTotal: number,
  method: AmendmentPaymentMethod | null,
): PaymentRow[] {
  const rows: PaymentRow[] = [];
  for (const [paidMethod, amount] of netByMethod(paid)) {
    if (amount !== 0) rows.push({ method: paidMethod, amount: -amount });
  }
  if (newTotal > 0) rows.push({ method: resolveSettlementMethod(paid, method), amount: newTotal });
  return rows;
}

function netByMethod(paid: PaymentRow[]): Map<AmendmentPaymentMethod, number> {
  const net = new Map<AmendmentPaymentMethod, number>();
  for (const row of paid) net.set(row.method, (net.get(row.method) ?? 0) + row.amount);
  return net;
}

/**
 * How the corrected bill is settled: what the amendment asked for, else the
 * method the order was mostly paid through, else cash. The ledger's debit side
 * has to agree with the payment row, so both read this rather than deciding
 * separately.
 */
export function resolveSettlementMethod(
  paid: PaymentRow[],
  requested: AmendmentPaymentMethod | null,
): AmendmentPaymentMethod {
  if (requested) return requested;
  let best: AmendmentPaymentMethod | null = null;
  let bestAmount = 0;
  for (const [method, amount] of netByMethod(paid)) {
    if (amount > bestAmount) {
      best = method;
      bestAmount = amount;
    }
  }
  return best ?? "cash";
}
