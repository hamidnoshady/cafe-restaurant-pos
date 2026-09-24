/**
 * The one fa-IR date-time formatter for the assistant's dashboard surfaces.
 *
 * Five screens used to spell their own `Intl.DateTimeFormat("fa-IR", …)`
 * (the history sidebar, the coworker panels, the autopilot activity feed,
 * the knowledge index and the usage report) — the same two formats, copied
 * five times. They live here now, so the assistant's timestamps can never
 * drift between its own screens. `fa-IR` resolves to the Persian/Shamsi
 * calendar, which is the repo's Shamsi-only display rule (AGENTS.md); the
 * value on the wire stays an ISO/Gregorian timestamp.
 */

/** «۱۵ فروردین ۱۴۰۳، ۱۴:۳۰» — the chat surfaces' list timestamps. `null` renders «—». */
export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

/** «۱۴۰۳/۰۱/۰۱، ۱۴:۳۰» — the compact form for dense management tables. */
export function formatShortDateTime(value: string): string {
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}
