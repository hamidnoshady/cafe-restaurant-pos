/**
 * What the two checkout screens hold while the cashier decides how a bill is
 * being paid, and how that turns into a request body.
 *
 * Kept out of the components because it is the part that can be wrong: the
 * amounts are Toman strings typed by a person (Persian digits, thousands
 * separators, an empty box halfway through typing), the bill is integer Rial,
 * and the server will refuse anything that doesn't add up to the Rial. Both
 * screens ask the same questions of it — what is still owed, is this ready to
 * send, what does the receipt say, does the drawer open — so they ask here.
 */
import { parseToRial, type Rial } from "./money";
import type { PaymentMethodView } from "./payment-methods";

export interface PaymentDraftRow {
  /** Stable across re-renders so React keys and focus survive a row being removed. */
  key: string;
  methodId: string;
  /** As typed, in Toman. Empty while the cashier is still typing. */
  amount: string;
  reference: string;
}

export interface PaymentDraft {
  /**
   * False — the ordinary sale — means one way takes the whole bill and no
   * amount is typed at all. True is the split: every row carries its own
   * amount and they have to add up.
   */
  split: boolean;
  /** The chosen way when not splitting. */
  methodId: string;
  rows: PaymentDraftRow[];
}

let rowCounter = 0;

export function newDraftRow(methodId: string, amount = ""): PaymentDraftRow {
  rowCounter += 1;
  return { key: `tender-${rowCounter}`, methodId, amount, reference: "" };
}

/** The draft a screen opens with: the first way offered, whole bill, no split. */
export function emptyPaymentDraft(methods: readonly PaymentMethodView[]): PaymentDraft {
  const first = methods[0]?.id ?? "";
  return { split: false, methodId: first, rows: [newDraftRow(first)] };
}

/** A row's amount in Rial, or null while it is empty or not a number yet. */
export function draftRowRial(row: PaymentDraftRow): Rial | null {
  if (!row.amount.trim()) return null;
  try {
    const rial = parseToRial(row.amount, "toman");
    return rial > 0 ? rial : null;
  } catch {
    return null;
  }
}

/** What the typed rows come to so far — rows still being typed count as zero. */
export function draftTotal(draft: PaymentDraft, due: Rial): Rial {
  if (!draft.split) return due;
  return draft.rows.reduce((sum, row) => sum + (draftRowRial(row) ?? 0), 0);
}

/** Still owed. Negative once the rows overshoot the bill. */
export function draftRemaining(draft: PaymentDraft, due: Rial): Rial {
  return due - draftTotal(draft, due);
}

export function methodOf(methods: readonly PaymentMethodView[], id: string): PaymentMethodView | undefined {
  return methods.find((method) => method.id === id);
}

/** Whether this payment should kick the cash drawer — any slice of it taken in cash does. */
export function draftOpensDrawer(draft: PaymentDraft, methods: readonly PaymentMethodView[]): boolean {
  const ids = draft.split ? draft.rows.map((row) => row.methodId) : [draft.methodId];
  return ids.some((id) => methodOf(methods, id)?.opensDrawer === true);
}

/** Whether any way in this payment is a tab, and so needs a customer named. */
export function draftNeedsCustomer(draft: PaymentDraft, methods: readonly PaymentMethodView[]): boolean {
  const ids = draft.split ? draft.rows.map((row) => row.methodId) : [draft.methodId];
  return ids.some((id) => methodOf(methods, id)?.settlement === "credit");
}

export interface PaymentDraftBody {
  methodId: string;
  /** Absent means "take whatever is left" — see TenderInput.amount in payment-methods.ts. */
  amount?: Rial;
  reference?: string;
}

export type DraftResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The `payments` array for POST /api/orders/[id]/pay, or the reason this
 * draft isn't payable yet. The error codes are the API's own, so a screen
 * shows the same Persian sentence whether the check failed here or there.
 *
 * Not splitting sends no amount at all: "take the whole bill this way" stays
 * one field, and the server is the only place that decides what the whole bill
 * is — a screen that computed it from a stale total would be the one bug this
 * costs nothing to make impossible.
 */
export function paymentDraftBody(
  draft: PaymentDraft,
  methods: readonly PaymentMethodView[],
  due: Rial,
): DraftResult<PaymentDraftBody[]> {
  const rows = draft.split ? draft.rows : [{ ...newDraftRow(draft.methodId), amount: "" }];
  if (rows.length === 0) return { ok: false, error: "no_payment" };

  const body: PaymentDraftBody[] = [];
  for (const row of rows) {
    const method = methodOf(methods, row.methodId);
    if (!method) return { ok: false, error: "invalid_payment_method" };
    if (method.requiresReference && !row.reference.trim()) {
      return { ok: false, error: "payment_reference_required" };
    }
    if (!draft.split) {
      body.push({ methodId: method.id, reference: row.reference.trim() || undefined });
      continue;
    }
    const amount = draftRowRial(row);
    if (amount === null) return { ok: false, error: "invalid_amount" };
    // The last slice is sent open — "take the rest" — even though the cashier
    // typed a figure for it. The typed figures are checked against `due` just
    // below, so the two agree in every ordinary sale; sending the last one
    // open is what keeps the sale from failing outright when the screen's
    // total is a little behind the server's (see TenderInput.amount).
    const isLast = row === rows[rows.length - 1];
    body.push({
      methodId: method.id,
      amount: isLast ? undefined : amount,
      reference: row.reference.trim() || undefined,
    });
  }
  if (draft.split && draftRemaining(draft, due) !== 0) {
    return { ok: false, error: "payment_total_mismatch" };
  }
  return { ok: true, value: body };
}

/**
 * The tender lines to print: the name the business gave each way, with what it
 * took. A bill that wasn't split still prints one line — the way's own name,
 * which is the point of letting a business rename «کارت‌خوان» to «پوز ملت».
 */
export function draftReceiptPayments(
  draft: PaymentDraft,
  methods: readonly PaymentMethodView[],
  due: Rial,
): { label: string; amount: Rial }[] {
  if (!draft.split) {
    const method = methodOf(methods, draft.methodId);
    return method ? [{ label: method.name, amount: due }] : [];
  }
  return draft.rows.flatMap((row) => {
    const method = methodOf(methods, row.methodId);
    const amount = draftRowRial(row);
    return method && amount !== null ? [{ label: method.name, amount }] : [];
  });
}
