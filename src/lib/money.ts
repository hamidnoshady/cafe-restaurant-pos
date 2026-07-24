/**
 * Money utilities.
 *
 * STORAGE: integer amounts in the smallest unit — Rial — everywhere
 * (DB BIGINT, API payloads, calculations).
 * DISPLAY: formatted as Toman (÷10) or Rial with Persian digits and
 * thousands grouping. 1 Toman = 10 Rial.
 */
import { formatPersianNumber, toLatinDigits } from "./digits";

export type Rial = number; // integer; JS number is safe up to 2^53-1 rial

/** Rial → whole Toman (truncates the single-rial digit, which is always 0 in practice). */
export function rialToToman(rial: Rial): number {
  return Math.trunc(rial / 10);
}

export function tomanToRial(toman: number): Rial {
  return toman * 10;
}

/** e.g. 1_250_000 rial → «۱۲۵٬۰۰۰ تومان» */
export function formatToman(rial: Rial, opts: { withUnit?: boolean } = {}): string {
  const { withUnit = true } = opts;
  const s = formatPersianNumber(rialToToman(rial));
  return withUnit ? `${s} تومان` : s;
}

/** e.g. 1_250_000 rial → «۱٬۲۵۰٬۰۰۰ ریال» */
export function formatRial(rial: Rial, opts: { withUnit?: boolean } = {}): string {
  const { withUnit = true } = opts;
  const s = formatPersianNumber(rial);
  return withUnit ? `${s} ریال` : s;
}

export function formatTomanText(rial: string, opts: { withUnit?: boolean } = {}): string {
  if (!/^-?\d+$/.test(rial)) throw new Error(`Not a valid amount: ${rial}`);
  const toman = BigInt(rial) / 10n;
  const value = formatPersianNumber(toman);
  return opts.withUnit === false ? value : `${value} تومان`;
}

export function parseToRialText(input: string, unit: "toman" | "rial" = "toman"): string {
  const cleaned = toLatinDigits(input).replace(/[٬,\s]/g, "");
  if (!/^-?\d+$/.test(cleaned)) throw new Error(`Not a valid amount: ${input}`);
  const value = BigInt(cleaned);
  return (unit === "toman" ? value * 10n : value).toString();
}

/**
 * Parse user input (possibly Persian digits, with separators) into integer
 * Rial. `unit` says which unit the input is denominated in.
 */
export function parseToRial(input: string, unit: "toman" | "rial" = "toman"): Rial {
  const cleaned = toLatinDigits(input).replace(/[٬,\s]/g, "");
  if (!/^-?\d+$/.test(cleaned)) {
    throw new Error(`Not a valid amount: ${input}`);
  }
  const n = Number(cleaned);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Amount out of range: ${input}`);
  }
  return unit === "toman" ? tomanToRial(n) : n;
}
