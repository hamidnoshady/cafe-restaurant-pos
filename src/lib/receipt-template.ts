/**
 * Customer-facing receipt template — pure HTML string builder, no DB/I/O.
 *
 * The print agent (print-agent/) screenshots this HTML with a real browser
 * engine and sends the result to the printer as a raster image (see
 * src/lib/escpos.ts's header comment for why: no ESC/POS printer we can
 * target reliably shapes/reorders Persian text on its own). Keeping the
 * template a pure function of plain data means it can be unit tested as a
 * string and reused unchanged by the setup wizard's test-print preview.
 */
import { toPersianDigits } from "./digits";
import { formatJalali } from "./jalali";
import { formatToman, type Rial } from "./money";

export interface ReceiptBusinessInfo {
  name: string;
  address?: string | null;
  phone?: string | null;
  /** e.g. "با تشکر از خرید شما" — shown at the bottom. */
  footerMessage?: string | null;
}

export interface ReceiptLine {
  name: string;
  quantity: number;
  /** modifiers included, per line total (Rial) */
  lineTotal: Rial;
  modifiersLabel?: string | null;
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "نقدی",
  card: "کارت‌خوان",
  card_to_card: "کارت‌به‌کارت",
  online: "پرداخت آنلاین",
  credit: "نسیه",
};

export interface ReceiptData {
  business: ReceiptBusinessInfo;
  /** e.g. "#42" or "T-42" (formatQueueLabel) */
  orderLabel: string;
  /** e.g. "حضوری — میز ۳" or "بیرون‌بر" */
  orderTypeLabel: string;
  issuedAt: Date | string;
  lines: ReceiptLine[];
  subtotal: Rial;
  discount: Rial;
  tax: Rial;
  total: Rial;
  paymentMethod?: string | null;
  cashierName?: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** 58mm and 80mm are the two standard thermal receipt widths; content width leaves ~2mm margins each side. */
export const PAPER_WIDTH_PRESETS = { 58: 372, 80: 512 } as const;
export type PaperWidthMm = keyof typeof PAPER_WIDTH_PRESETS;

export function renderReceiptHtml(data: ReceiptData, opts: { paperWidthMm?: PaperWidthMm } = {}): string {
  const widthPx = PAPER_WIDTH_PRESETS[opts.paperWidthMm ?? 80];
  const dateLabel = toPersianDigits(formatJalali(data.issuedAt, { withMonthName: true }));

  const lineRows = data.lines
    .map((l) => {
      const modRow = l.modifiersLabel
        ? `<div class="mods">${escapeHtml(l.modifiersLabel)}</div>`
        : "";
      return `
        <div class="line">
          <div class="line-main">
            <span class="qty">${toPersianDigits(l.quantity)}×</span>
            <span class="name">${escapeHtml(l.name)}</span>
            <span class="amount">${formatToman(l.lineTotal, { withUnit: false })}</span>
          </div>
          ${modRow}
        </div>`;
    })
    .join("");

  const discountRow =
    data.discount > 0
      ? `<div class="totals-row"><span>تخفیف</span><span>-${formatToman(data.discount, { withUnit: false })}</span></div>`
      : "";
  const taxRow =
    data.tax > 0
      ? `<div class="totals-row"><span>مالیات</span><span>${formatToman(data.tax, { withUnit: false })}</span></div>`
      : "";
  const paymentRow = data.paymentMethod
    ? `<div class="totals-row"><span>روش پرداخت</span><span>${PAYMENT_METHOD_LABELS[data.paymentMethod] ?? data.paymentMethod}</span></div>`
    : "";

  return `<!doctype html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${widthPx}px;
    font-family: "Vazirmatn", sans-serif;
    font-size: 22px;
    line-height: 1.5;
    color: #000;
    background: #fff;
    padding: 12px 10px;
  }
  .center { text-align: center; }
  .business-name { font-size: 28px; font-weight: 700; }
  .business-meta { font-size: 18px; color: #222; margin-top: 4px; }
  .divider { border-top: 2px dashed #000; margin: 10px 0; }
  .meta-row { display: flex; justify-content: space-between; font-size: 18px; margin: 2px 0; }
  .order-label { font-size: 26px; font-weight: 700; text-align: center; margin: 6px 0; }
  .line { margin: 6px 0; }
  .line-main { display: flex; align-items: baseline; gap: 6px; }
  .line-main .qty { flex-shrink: 0; }
  .line-main .name { flex: 1; }
  .line-main .amount { flex-shrink: 0; }
  .mods { font-size: 16px; color: #333; padding-inline-start: 24px; }
  .totals-row { display: flex; justify-content: space-between; font-size: 19px; margin: 3px 0; }
  .grand-total { display: flex; justify-content: space-between; font-size: 26px; font-weight: 700; margin-top: 6px; }
  .footer { text-align: center; font-size: 18px; margin-top: 14px; }
</style>
</head>
<body>
  <div class="center business-name">${escapeHtml(data.business.name)}</div>
  ${data.business.address ? `<div class="center business-meta">${escapeHtml(data.business.address)}</div>` : ""}
  ${data.business.phone ? `<div class="center business-meta" dir="ltr">${toPersianDigits(data.business.phone)}</div>` : ""}

  <div class="divider"></div>
  <div class="order-label">${escapeHtml(data.orderLabel)}</div>
  <div class="meta-row"><span>${escapeHtml(data.orderTypeLabel)}</span><span>${dateLabel}</span></div>
  ${data.cashierName ? `<div class="meta-row"><span>صندوق‌دار</span><span>${escapeHtml(data.cashierName)}</span></div>` : ""}

  <div class="divider"></div>
  ${lineRows}

  <div class="divider"></div>
  <div class="totals-row"><span>جمع جزء</span><span>${formatToman(data.subtotal, { withUnit: false })}</span></div>
  ${discountRow}
  ${taxRow}
  <div class="grand-total"><span>جمع کل</span><span>${formatToman(data.total)}</span></div>
  ${paymentRow}

  <div class="divider"></div>
  ${data.business.footerMessage ? `<div class="footer">${escapeHtml(data.business.footerMessage)}</div>` : ""}
</body>
</html>`;
}
