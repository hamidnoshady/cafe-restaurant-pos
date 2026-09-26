/**
 * Invoice state machine. Statuses that exist in the schema are the only
 * ones this module will move between.
 */

export type InvoiceStatus = "draft" | "open" | "partially_paid" | "paid" | "overdue" | "void";

export interface InvoiceState {
  status: InvoiceStatus;
  totalRial: number;
  paidRial: number;
  dueAt: string | null;
}

export class InvoiceStateError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export function outstandingRial(invoice: Pick<InvoiceState, "totalRial" | "paidRial">): number {
  return Math.max(0, Math.floor(invoice.totalRial) - Math.floor(invoice.paidRial));
}

function pastDue(invoice: InvoiceState, nowIso: string): boolean {
  return invoice.dueAt != null && invoice.dueAt <= nowIso;
}

/**
 * Apply a positive integer payment. Overpayment is refused. A full payment
 * lands on `paid`. A partial payment of an invoice that is already due stays
 * `overdue`; otherwise it becomes `partially_paid`.
 */
export function applyPayment(
  invoice: InvoiceState,
  amountRial: number,
  nowIso: string,
): InvoiceState {
  if (!Number.isSafeInteger(amountRial) || amountRial <= 0) {
    throw new InvoiceStateError("bad_amount");
  }
  if (invoice.status === "void") throw new InvoiceStateError("invoice_void");
  if (invoice.status === "paid") throw new InvoiceStateError("invoice_paid");
  if (invoice.status === "draft") throw new InvoiceStateError("invoice_draft");
  const outstanding = outstandingRial(invoice);
  if (amountRial > outstanding) throw new InvoiceStateError("overpayment");
  const paidRial = invoice.paidRial + amountRial;
  const status: InvoiceStatus =
    paidRial >= invoice.totalRial
      ? "paid"
      : pastDue(invoice, nowIso) || invoice.status === "overdue"
        ? "overdue"
        : "partially_paid";
  return { ...invoice, paidRial, status };
}

/** Void only when no money has been applied. */
export function voidInvoice(invoice: InvoiceState): InvoiceState {
  if (invoice.status === "void") return invoice;
  if (invoice.paidRial > 0) throw new InvoiceStateError("payment_applied");
  if (invoice.status !== "draft" && invoice.status !== "open" && invoice.status !== "overdue") {
    throw new InvoiceStateError("not_voidable");
  }
  return { ...invoice, status: "void" };
}

/** Open or partially paid invoices past their due date become overdue. */
export function markOverdue(invoice: InvoiceState, nowIso: string): InvoiceState {
  if (invoice.status !== "open" && invoice.status !== "partially_paid") return invoice;
  if (!pastDue(invoice, nowIso)) return invoice;
  if (invoice.paidRial >= invoice.totalRial) return invoice;
  return { ...invoice, status: "overdue" };
}

/** Publish a draft. */
export function openInvoice(invoice: InvoiceState): InvoiceState {
  if (invoice.status !== "draft") throw new InvoiceStateError("not_draft");
  return { ...invoice, status: "open" };
}
