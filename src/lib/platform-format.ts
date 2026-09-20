/**
 * Centralized presentation helpers for the super-admin console.
 *
 * Every operator-facing page is Persian RTL and must render Jalali dates,
 * Persian digits and Toman currency labels. Before this module those helpers
 * were reimplemented ad-hoc inside individual pages (a `fmtDate` here, a
 * hand-rolled number format there); this is the single place they live now so
 * the whole console formats identically and a fix lands everywhere at once.
 *
 * Pure and framework-free (no React, no DOM) so it can be imported by both
 * server routes and client components, and unit-tested directly.
 */
import { toPersianDigits, formatPersianNumber } from "./digits";
import { formatJalali } from "./jalali";
import { formatToman, type Rial } from "./money";

export { toPersianDigits, formatPersianNumber };

/**
 * Jalali date for operators, Persian digits throughout. `withTime` appends the
 * clock; `withMonthName` spells the month («۳ مهر ۱۴۰۳») instead of numeric.
 * A null/blank value renders the em-dash placeholder every table uses so a
 * missing timestamp never shows as blank or "Invalid Date".
 */
export function fmtDate(
  value: string | number | Date | null | undefined,
  opts: { withTime?: boolean; withMonthName?: boolean } = {},
): string {
  if (value === null || value === undefined || value === "") return "—";
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return toPersianDigits(
      formatJalali(d, {
        withTime: opts.withTime ?? false,
        withMonthName: opts.withMonthName ?? false,
      }),
    );
  } catch {
    return "—";
  }
}

/** Jalali date + time, the console's default for audit/activity timestamps. */
export function fmtDateTime(value: string | number | Date | null | undefined): string {
  return fmtDate(value, { withTime: true });
}

/**
 * A compact "how long ago" label in Persian for activity/last-seen columns,
 * falling back to an absolute Jalali date once the event is older than a week
 * (relative labels stop being useful past that). Future timestamps read «همین
 * حالا» rather than a negative duration.
 */
export function fmtRelative(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return "همین حالا";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "همین حالا";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${toPersianDigits(min)} دقیقه پیش`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${toPersianDigits(hr)} ساعت پیش`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${toPersianDigits(day)} روز پیش`;
  return fmtDate(d);
}

/** Toman currency from a Rial amount, Persian digits, with the «تومان» unit. */
export function fmtToman(rial: Rial | number | string | null | undefined, opts: { withUnit?: boolean } = {}): string {
  if (rial === null || rial === undefined || rial === "") return "—";
  const n = typeof rial === "string" ? Number(rial) : rial;
  if (!Number.isFinite(n)) return "—";
  return formatToman(Math.round(n), { withUnit: opts.withUnit ?? true });
}

/** Human storage size (KB/MB/GB/TB) with Persian digits and Persian unit. */
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${toPersianDigits(bytes)} بایت`;
  const units = ["کیلوبایت", "مگابایت", "گیگابایت", "ترابایت"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${toPersianDigits(String(rounded))} ${units[unit]}`;
}

/** Percentage with Persian digits, e.g. «۹۸٪». */
export function fmtPercent(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = decimals > 0 ? value.toFixed(decimals).replace(".", "٫") : String(Math.round(value));
  return `${toPersianDigits(rounded)}٪`;
}
