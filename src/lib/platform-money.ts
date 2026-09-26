/**
 * Money helpers for the super-admin console — the ONE place the Rial↔Toman
 * conversion lives (§41). Storage, the ledger, invoices and every API
 * contract are integer Rial; the console *displays* Toman.
 *
 *   1 Toman = 10 Rial — never spell `value * 10` in a component again.
 */
import { toPersianDigits } from "./digits";

export const RIAL_PER_TOMAN = 10;

/** Integer Toman from integer Rial (banker-free, always floored). */
export function rialToToman(rial: number): number {
  return Math.floor(rial / RIAL_PER_TOMAN);
}

/** Integer Rial from integer Toman. */
export function tomanToRial(toman: number): number {
  return Math.floor(toman) * RIAL_PER_TOMAN;
}

/** Format integer Rial as a Persian-digit Toman string with «٬» grouping. */
export function formatToman(rial: number): string {
  return toPersianDigits(
    rialToToman(rial).toLocaleString("en-US").replace(/,/g, "٬"),
  );
}

/** Format integer Rial as a Persian-digit Rial string with «٬» grouping. */
export function formatRial(rial: number): string {
  return toPersianDigits(Math.floor(rial).toLocaleString("en-US").replace(/,/g, "٬"));
}

/** `«۱٬۲۰۰٬۰۰۰ تومان»` in one call — the console's standard money label. */
export function tomanLabel(rial: number): string {
  return `${formatToman(rial)} تومان`;
}
