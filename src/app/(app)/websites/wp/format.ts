/**
 * Dates as this dashboard shows them: Shamsi, through the browser's fa-IR
 * calendar. Never a raw ISO string, and never `new Date().toLocaleString()`
 * with a Gregorian locale — see CLAUDE.md's "Shamsi-only dates".
 */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" });
}
