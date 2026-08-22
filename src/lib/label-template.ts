/**
 * Phase 27 Wave 4 — barcode label template (pure HTML string builder).
 *
 * The same pattern as receipt-template.ts: a pure function of plain data the
 * print agent screenshots and sends to the printer as a raster. Each of the
 * four retail trades labels its stock with the fields that trade actually
 * reads at the counter — a cosmetics label shows shade and expiry, a jewellery
 * label shows عیار and وزن — so one template, four field sets, verified by a
 * pure string test rather than by eye.
 */
import { toPersianDigits } from "./digits";
import { formatJalali } from "./jalali";
import { formatMoney, type MoneyUnit, type Rial } from "./money";

export type LabelTrade = "jewelry" | "watch" | "accessories" | "cosmetics";

/** The item facts a trade might print; only the ones a trade cares about are used. */
export interface LabelItem {
  name: string;
  /** Shelf price (Rial). */
  price?: Rial | null;
  /** cosmetics: the shade / colour name. */
  shade?: string | null;
  /** cosmetics: expiry date (ISO, Gregorian — stored convention, Jalali at display). */
  expiryDate?: string | null;
  /** jewelry: عیار, e.g. "۱۸". */
  purity?: string | null;
  /** jewelry: وزن (e.g. "۱٫۲۳ گرم"). */
  weight?: string | null;
  /** watch: the model reference. */
  model?: string | null;
  /** watch: the unit's serial number. */
  serial?: string | null;
  /** accessories: the size (e.g. "سایز ۵۵"). */
  size?: string | null;
}

export interface LabelField {
  label: string;
  value: string;
}

/** The fields a trade's label carries, in display order. */
export function labelFieldsForTrade(
  trade: LabelTrade,
  item: LabelItem,
  unit: MoneyUnit = "toman",
): LabelField[] {
  const fields: LabelField[] = [];
  if (item.price != null) {
    fields.push({ label: "قیمت", value: formatMoney(item.price, unit, { withUnit: false }) });
  }
  switch (trade) {
    case "cosmetics":
      if (item.shade) fields.push({ label: "رنگ", value: item.shade });
      if (item.expiryDate) {
        fields.push({ label: "انقضا", value: toPersianDigits(formatJalali(item.expiryDate)) });
      }
      break;
    case "jewelry":
      if (item.purity) fields.push({ label: "عیار", value: item.purity });
      if (item.weight) fields.push({ label: "وزن", value: item.weight });
      break;
    case "watch":
      if (item.model) fields.push({ label: "مدل", value: item.model });
      if (item.serial) fields.push({ label: "سریال", value: item.serial });
      break;
    case "accessories":
      if (item.size) fields.push({ label: "سایز", value: item.size });
      break;
  }
  return fields;
}

export interface LabelData {
  businessName: string;
  itemName: string;
  code: string;
  fields: LabelField[];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Render one label as HTML. The code is shown in a large, monospace,
 * LTR block — the human-readable form of the barcode — and the trade's
 * fields follow. Rendered at the print agent's 58mm width so it fits a
 * standard label printer on the same ESC/POS raster path receipts use.
 */
export function renderLabelHtml(data: LabelData): string {
  const fieldRows = data.fields
    .map(
      (f) =>
        `<div class="field"><span class="field-label">${escapeHtml(f.label)}</span><span class="field-value">${escapeHtml(
          f.value,
        )}</span></div>`,
    )
    .join("");

  return `<!doctype html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${372}px;
    font-family: "Vazirmatn", sans-serif;
    font-size: 20px;
    line-height: 1.5;
    color: #000;
    background: #fff;
    padding: 10px 10px;
  }
  .business { font-size: 16px; color: #333; }
  .item-name { font-size: 26px; font-weight: 700; margin: 4px 0 6px; }
  .barcode { direction: ltr; font-family: "Courier New", monospace; font-size: 30px; letter-spacing: 2px; margin: 4px 0; }
  .field { display: flex; justify-content: space-between; font-size: 19px; margin: 2px 0; }
  .field-label { color: #333; }
  .field-value { font-weight: 600; }
</style>
</head>
<body>
  <div class="business">${escapeHtml(data.businessName)}</div>
  <div class="item-name">${escapeHtml(data.itemName)}</div>
  ${fieldRows}
  <div class="barcode">${escapeHtml(data.code)}</div>
</body>
</html>`;
}
