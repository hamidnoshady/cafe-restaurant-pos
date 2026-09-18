/**
 * Dates as this dashboard shows them: Shamsi, through the browser's fa-IR
 * calendar. Never a raw ISO string, and never `new Date().toLocaleString()`
 * with a Gregorian locale — see CLAUDE.md's "Shamsi-only dates".
 */
import { normalizeNumericText } from "@/lib/digits";

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" });
}

/**
 * Parse a number an owner typed into a WP Manager input, in whatever shape a
 * Persian keyboard produces: Persian or Latin digits, «٬»/«,» group marks,
 * «٫»/«.» decimals. Returns null when nothing numeric was typed — which the
 * old inline `replace(/[^\d.]/g, "")` parsing got badly wrong: Persian digits
 * were stripped entirely, `Number("")` is `0`, and «۱۲۰٬۰۰۰ تومان» went to the
 * store as a price of zero.
 *
 * Grouping is left on (a comma between digits is a thousand-mark, the shape
 * people paste), so decimals are the «.»/«٫» the `decimal` input mode offers.
 * Text-bearing input is refused outright: «۱۲۰ هزار تومان» would otherwise
 * parse as a plausible-looking but wrong price, and a price push is not the
 * place to guess.
 */
export function parseAmountInput(text: string, options: { allowDecimal?: boolean } = {}): number | null {
  const { allowDecimal = true } = options;
  const trimmed = text.trim();
  if (!trimmed || /\p{L}/u.test(trimmed)) return null;
  const normalized = normalizeNumericText(trimmed, { allowDecimal });
  if (!normalized || normalized === "-") return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * A store amount the way every other number in the dashboard reads: grouped
 * Persian digits, with the store's own currency code beside it when the
 * payload carried one («۱۸۵٬۰۰۰ IRT»), never a raw "185000.00".
 */
export function formatStoreAmount(total: string | null | undefined, currency?: string | null): string {
  if (total === null || total === undefined || total === "") return "—";
  const value = parseAmountInput(total);
  const grouped = value === null ? total : value.toLocaleString("fa-IR");
  return currency ? `${grouped} ${currency}` : grouped;
}
