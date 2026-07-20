/**
 * Persian digit formatting — display layer only.
 * Data is always stored with Latin (ASCII) digits.
 */

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Convert ASCII digits in a string (or a number) to Persian digits. */
export function toPersianDigits(value: string | number | bigint): string {
  return String(value).replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]);
}

/** Convert Persian and Arabic-Indic digits back to ASCII. */
export function toLatinDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
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
