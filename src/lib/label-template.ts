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
import { ean13Modules } from "./barcode";
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
 * The scannable bars of an EAN-13/UPC-A code as an inline SVG, or null for a
 * code in another shape (which stays text-only). 2px per module at the 372px
 * label width leaves quiet zones a real scanner accepts; the bars print pure
 * black on the same monochrome raster path as the rest of the label.
 */
function barcodeSvg(code: string): string | null {
  const modules = ean13Modules(code);
  if (!modules) return null;
  const moduleWidth = 2;
  const height = 64;
  const rects: string[] = [];
  let run = 0;
  for (let i = 0; i <= modules.length; i++) {
    if (i < modules.length && modules[i] === "1") {
      run += 1;
      continue;
    }
    if (run > 0) {
      const x = (i - run) * moduleWidth;
      rects.push(`<rect x="${x}" y="0" width="${run * moduleWidth}" height="${height}"/>`);
      run = 0;
    }
  }
  const width = modules.length * moduleWidth;
  return `<svg class="bars" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" fill="black" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

/**
 * Render one label as HTML. An EAN-13/UPC-A code (including every minted
 * internal code) is drawn as real scannable bars with the digits beneath —
 * bars are the entire point of a shelf label, since a laser/CCD scanner
 * cannot read printed digits. Codes in any other shape keep the monospace
 * LTR text block. The trade's fields follow. Rendered at the print agent's
 * 58mm width so it fits a standard label printer on the same ESC/POS raster
 * path receipts use.
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

  const bars = barcodeSvg(data.code);
  const barcodeBlock = bars
    ? `<div class="barcode-bars">${bars}<div class="code-text">${escapeHtml(data.code)}</div></div>`
    : `<div class="barcode">${escapeHtml(data.code)}</div>`;

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
  .barcode-bars { direction: ltr; text-align: center; margin: 8px 0 2px; }
  .barcode-bars .bars { display: block; margin: 0 auto; }
  .code-text { font-family: "Courier New", monospace; font-size: 22px; letter-spacing: 3px; margin-top: 2px; }
  .field { display: flex; justify-content: space-between; font-size: 19px; margin: 2px 0; }
  .field-label { color: #333; }
  .field-value { font-weight: 600; }
</style>
</head>
<body>
  <div class="business">${escapeHtml(data.businessName)}</div>
  <div class="item-name">${escapeHtml(data.itemName)}</div>
  ${fieldRows}
  ${barcodeBlock}
</body>
</html>`;
}

/**
 * Render many labels as ONE printable document, each on its own page.
 *
 * This is the browser-dialog path of a bulk label run: with no hardware
 * printer paired, printing a store room's labels one `window.print()` at a
 * time would open hundreds of dialogs. One sheet, one dialog; `page-break`
 * keeps each label a separate page/sticker.
 */
export function renderLabelSheetHtml(labels: LabelData[]): string {
  const pages = labels
    .map((label) => {
      const single = renderLabelHtml(label);
      const body = single.slice(single.indexOf("<body>") + "<body>".length, single.indexOf("</body>"));
      return `<div class="label-page">${body}</div>`;
    })
    .join("");

  return `<!doctype html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Vazirmatn", sans-serif; color: #000; background: #fff; }
  .label-page {
    width: ${372}px;
    padding: 10px 10px;
    page-break-after: always;
    break-after: page;
    font-size: 20px;
    line-height: 1.5;
  }
  .business { font-size: 16px; color: #333; }
  .item-name { font-size: 26px; font-weight: 700; margin: 4px 0 6px; }
  .barcode { direction: ltr; font-family: "Courier New", monospace; font-size: 30px; letter-spacing: 2px; margin: 4px 0; }
  .barcode-bars { direction: ltr; text-align: center; margin: 8px 0 2px; }
  .barcode-bars .bars { display: block; margin: 0 auto; }
  .code-text { font-family: "Courier New", monospace; font-size: 22px; letter-spacing: 3px; margin-top: 2px; }
  .field { display: flex; justify-content: space-between; font-size: 19px; margin: 2px 0; }
  .field-label { color: #333; }
  .field-value { font-weight: 600; }
</style>
</head>
<body>
  ${pages}
</body>
</html>`;
}
