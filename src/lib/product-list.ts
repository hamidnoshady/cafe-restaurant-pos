/**
 * «لیست محصولات» — the pure rules behind the products workspace list
 * (dashboard/products/products-list-section.tsx). Framework-free and DB-free
 * per repo convention so the section stays markup and the Vitest unit suite
 * can pin the search and export behaviour.
 */
import { toLatinDigits } from "./digits";

/**
 * The structural slice of the trade's `VariantSummary` the list reads, kept
 * minimal so this module never imports the DB-touching service that defines
 * the full type.
 */
export interface ProductListRow {
  name: string;
  parentName: string | null;
  sku: string | null;
  barcode: string | null;
  unit: string | null;
  kind: string;
  quantity: string;
  unitPrice: number | null;
  unitCost: number | null;
}

/** A row whose children carry the sellable units (see migrations/0050). */
export function isVariantParent(row: Pick<ProductListRow, "kind">): boolean {
  return row.kind === "variant_parent";
}

/**
 * Canonical form for both the search needle and the haystack fields:
 * lowercase, trimmed, with Persian/Arabic-Indic digits folded to ASCII. The
 * catalogue stores SKUs and barcodes in Latin digits, but this is a
 * Persian-first app — a cashier typing «۱۰۱۳» on a Persian keyboard must find
 * SKU `1013`. `toLowerCase` alone folds letters but not digits.
 */
export function normalizeListSearch(text: string): string {
  return toLatinDigits(text).trim().toLowerCase();
}

/** The per-row haystack, pre-computed once per dataset by the caller. */
export function variantSearchNeedles(row: ProductListRow): string[] {
  return [row.name, row.parentName ?? "", row.sku ?? "", row.barcode ?? ""]
    .map((field) => normalizeListSearch(field))
    .filter((field) => field.length > 0);
}

/** True when any of the row's fields contains the already-normalized needle. */
export function variantMatchesNeedle(needles: string[], needle: string): boolean {
  return needles.some((field) => field.includes(needle));
}

/**
 * The stock quantity for a CSV cell, in *Latin* digits. Export must stay
 * machine-parseable: the display formatter turns quantities into grouped
 * Persian text («۵٬۰۰۰»), which Excel cannot read and which disagreed with
 * the Latin prices in the same file. A family row has no stock of its own —
 * the table shows «—», the export leaves the cell empty rather than inventing
 * a zero.
 */
function quantityForCsv(row: ProductListRow): string {
  if (isVariantParent(row)) return "";
  const numeric = Number(row.quantity);
  return Number.isFinite(numeric) ? String(numeric) : row.quantity;
}

/** One CSV field, quoted per RFC 4180 (embedded quotes doubled). */
function csvCell(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * The «دانلود CSV» payload: a BOM (so Windows Excel detects UTF-8), quoted
 * header, one row per variant/family in the order shown, CRLF row endings.
 * Money columns are the raw integer Rial the API stores — that is what the
 * header advertises and what imports/accounting tools expect.
 */
export function buildProductsCsv(rows: ProductListRow[]): string {
  const head = ["نام", "خانواده", "کد کالا", "بارکد", "واحد", "موجودی", "قیمت فروش (ریال)", "قیمت خرید (ریال)"];
  const lines = rows.map((row) =>
    [
      row.name,
      row.parentName ?? "",
      row.sku ?? "",
      row.barcode ?? "",
      row.unit ?? "",
      quantityForCsv(row),
      row.unitPrice != null ? String(row.unitPrice) : "",
      row.unitCost != null ? String(row.unitCost) : "",
    ]
      .map(csvCell)
      .join(","),
  );
  return `\uFEFF${[head.map(csvCell).join(","), ...lines].join("\r\n")}`;
}
