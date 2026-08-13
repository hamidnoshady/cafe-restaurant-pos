/**
 * Phase 23 (issue #118) — WooCommerce amount <-> integer-Rial conversion.
 *
 * The POS stores money as integer Rial everywhere (see README). WooCommerce
 * stores decimal amounts in whatever unit the store prices in — almost always
 * Toman for Iranian stores, sometimes Rial. Each connection records its
 * `currency_unit`; this module is the one place those decimals become Rial.
 *
 * Pure and exact: string/bigint arithmetic only, never floating point, so a
 * Toman amount with decimals (e.g. 12.5 Toman) converts without drift.
 */

export type WooCurrencyUnit = "rial" | "toman";

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/** How many Rial one store unit is: 10 for Toman, 1 for Rial. */
export function rialScaleForUnit(unit: WooCurrencyUnit): bigint {
  return unit === "toman" ? 10n : 1n;
}

/**
 * A decimal store amount → whole Rial, rounded half-up. Accepts a number
 * (e.g. from JSON) or a string (the safe form); both are normalised through
 * string representation so `1.005` is never corrupted by float parsing.
 */
export function wooAmountToRial(amount: number | string, unit: WooCurrencyUnit): bigint {
  const text = typeof amount === "number" ? String(amount) : amount.trim();
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new Error(`invalid_woo_amount: ${text}`);
  const scale = rialScaleForUnit(unit);
  const whole = BigInt(m[1]) * scale;
  const frac = m[2] ?? "";
  if (!frac) return whole;

  // frac (as an integer) scaled by `scale`, divided by 10^len(frac), half-up.
  const fracNum = BigInt(frac);
  const denom = 10n ** BigInt(frac.length);
  const numerator = fracNum * scale;
  const q = numerator / denom;
  const r = numerator % denom;
  return whole + q + (r * 2n >= denom ? 1n : 0n);
}

/** Whole Rial → the store unit as a decimal string (no trailing `.0`). */
export function rialToWooAmount(rial: bigint | string, unit: WooCurrencyUnit): string {
  const value = typeof rial === "bigint" ? rial : BigInt(rial);
  if (value < 0n) throw new Error("negative_rial");
  if (unit === "rial") return value.toString();
  const q = value / 10n;
  const r = value % 10n;
  return r === 0n ? q.toString() : `${q}.${r}`;
}
