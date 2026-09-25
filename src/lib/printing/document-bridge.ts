/**
 * Turns the documents the till already builds (receipts, kitchen tickets)
 * into the one print-template data model. Operational printing renders that
 * model — the same function the designer preview uses.
 */
import type { KitchenTicketData } from "../kitchen-ticket-template";
import type { PrintDocumentData } from "../print-template";
import type { ReceiptData, ReceiptLine } from "../receipt-template";
import { formatMoney } from "../money";

export interface PrintBranding {
  logoDataUrl?: string | null;
  footer?: string | null;
  legalName?: string | null;
  taxId?: string | null;
  email?: string | null;
  website?: string | null;
}

function lineDetail(line: ReceiptLine): string | null {
  const parts: string[] = [];
  if (line.modifiersLabel) parts.push(line.modifiersLabel);
  if (line.goldBreakdown) {
    const gold = line.goldBreakdown;
    parts.push(
      `طلا ${formatMoney(gold.metalValue, "toman", { withUnit: false })} · اجرت ${formatMoney(gold.makingCharge, "toman", { withUnit: false })} · سود ${formatMoney(gold.profit, "toman", { withUnit: false })}`,
    );
  }
  if (line.batch) {
    parts.push(line.batch.expiryDate ? `${line.batch.batchNumber} · ${line.batch.expiryDate}` : line.batch.batchNumber);
  }
  if (line.serialProvenance) {
    const grade = line.serialProvenance.conditionGrade;
    parts.push(grade ? `وضعیت ${grade}` : "کالای کارکرده");
    if (line.serialProvenance.boxAndPapers) parts.push("با جعبه و مدارک");
  }
  return parts.length > 0 ? parts.join(" — ") : null;
}

export function receiptToPrintDocument(receipt: ReceiptData, branding: PrintBranding = {}): PrintDocumentData {
  return {
    business: {
      name: receipt.business.name,
      legalName: branding.legalName ?? null,
      address: receipt.business.address ?? null,
      phone: receipt.business.phone ?? null,
      taxId: branding.taxId ?? null,
      email: branding.email ?? null,
      website: branding.website ?? null,
      logoDataUrl: branding.logoDataUrl ?? null,
    },
    title: receipt.orderTypeLabel,
    number: receipt.orderLabel,
    subtitle: receipt.orderTypeLabel,
    issuedAt: receipt.issuedAt,
    customer: receipt.customerName ? { name: receipt.customerName } : null,
    cashierName: receipt.cashierName ?? null,
    lines: receipt.lines.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      detail: lineDetail(line),
      lineTotal: line.lineTotal,
    })),
    subtotal: receipt.subtotal,
    discount: receipt.discount,
    tax: receipt.tax,
    total: receipt.total,
    tip: receipt.tip,
    payments: receipt.payments ?? null,
    footer: receipt.business.footerMessage?.trim() || branding.footer?.trim() || null,
    unit: receipt.unit,
  };
}

export function kitchenToPrintDocument(ticket: KitchenTicketData, businessName = ""): PrintDocumentData {
  return {
    business: { name: businessName },
    title: ticket.label,
    number: ticket.label,
    subtitle: ticket.orderTypeLabel,
    issuedAt: ticket.sentAt,
    lines: ticket.lines.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      detail: [line.modifiersLabel, line.note].filter(Boolean).join(" — ") || null,
      lineTotal: 0,
    })),
    subtotal: 0,
    discount: 0,
    tax: 0,
    total: 0,
    note: ticket.orderNote ?? null,
  };
}
