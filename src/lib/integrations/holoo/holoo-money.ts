/**
 * Phase 26 (issue #125) Wave 2 — Holoo amount <-> integer-Rial conversion.
 *
 * The POS stores money as integer Rial everywhere (see README). Holoo stores
 * amounts in whatever unit the install was configured for — almost always
 * Rial for Iranian books, sometimes Toman. Each connection records its
 * `currency_unit`; this module is the one place those numbers become Rial,
 * the exact mirror of woo-money.ts (Phase 23).
 *
 * Pure and exact: string/bigint arithmetic only, never floating point, so an
 * amount with a fractional part converts without drift.
 */

export type HolooCurrencyUnit = "rial" | "toman";

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/** How many Rial one store unit is: 10 for Toman, 1 for Rial. */
export function rialScaleForUnit(unit: HolooCurrencyUnit): bigint {
  return unit === "toman" ? 10n : 1n;
}

/**
 * A decimal store amount → whole Rial, rounded half-up. Accepts a number
 * (e.g. from JSON) or a string (the safe form); both are normalised through
 * their string representation so a value like `1.005` is never corrupted by
 * float parsing.
 */
export function holooAmountToRial(amount: number | string, unit: HolooCurrencyUnit): bigint {
  const text = typeof amount === "number" ? String(amount) : amount.trim();
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new Error(`invalid_holoo_amount: ${text}`);
  const scale = rialScaleForUnit(unit);
  const whole = BigInt(m[1]) * scale;
  const frac = m[2] ?? "";
  if (!frac) return whole;

  const fracNum = BigInt(frac);
  const denom = 10n ** BigInt(frac.length);
  const numerator = fracNum * scale;
  const q = numerator / denom;
  const r = numerator % denom;
  return whole + q + (r * 2n >= denom ? 1n : 0n);
}

/** Whole Rial → the store unit as a decimal string (no trailing `.0`). */
export function rialToHolooAmount(rial: bigint | string, unit: HolooCurrencyUnit): string {
  const value = typeof rial === "bigint" ? rial : BigInt(rial);
  if (value < 0n) throw new Error("negative_rial");
  if (unit === "rial") return value.toString();
  const q = value / 10n;
  const r = value % 10n;
  return r === 0n ? q.toString() : `${q}.${r}`;
}
