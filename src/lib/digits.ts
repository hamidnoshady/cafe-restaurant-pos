/**
 * Persian digit formatting — display layer only.
 * Data is always stored with Latin (ASCII) digits.
 */

/**
 * Convert ASCII digits in a string (or a number) to Persian digits.
 * ⚡ Bolt: Optimized using char code manipulation instead of regex replacement
 * to significantly reduce string creation overhead.
 */
export function toPersianDigits(value: string | number | bigint): string {
  const str = String(value);
  let res = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      res += String.fromCharCode(code + 1728); // 1776 (۰) - 48 (0)
    } else {
      res += str[i];
    }
  }
  return res;
}

/**
 * Convert Persian and Arabic-Indic digits back to ASCII.
 * ⚡ Bolt: Optimized using char code manipulation instead of regex replacement
 * to significantly reduce string creation overhead.
 */
export function toLatinDigits(value: string): string {
  const str = String(value);
  let res = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 1776 && code <= 1785) {
      // Persian digits (۰-۹)
      res += String.fromCharCode(code - 1728);
    } else if (code >= 1632 && code <= 1641) {
      // Arabic-Indic digits (٠-٩)
      res += String.fromCharCode(code - 1584);
    } else {
      res += str[i];
    }
  }
  return res;
}

/** Group an integer with thousands separators (Persian comma «٬»). */
export function groupDigits(value: number | bigint, separator = "٬"): string {
  const negative = typeof value === "bigint" ? value < 0n : value < 0;
  const abs = (typeof value === "bigint" ? (value < 0n ? -value : value) : Math.abs(value)).toString();
  const grouped = abs.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return negative ? `-${grouped}` : grouped;
}

/** Grouped + Persian digits, ready for display. */
export function formatPersianNumber(value: number | bigint): string {
  return toPersianDigits(groupDigits(value));
}

/**
 * Format a decimal quantity for display, trimming to `maxDecimals` places and
 * dropping trailing zeros. Inventory quantities are stored with 9 decimal
 * places of exact cost-basis precision (see migrations/0015), which must
 * never leak into the UI as e.g. "18.000000000" — this is display-only,
 * storage/calculations keep the full string precision.
 */
export function formatQuantity(value: string | number, maxDecimals = 3): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return toPersianDigits(String(value));
  const fixed = n.toFixed(maxDecimals);
  const trimmed = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  return toPersianDigits(trimmed);
}
