/**
 * Which pages sit in the mobile bottom bar.
 *
 * A per-device preference, stored in `localStorage` like the sidebar's
 * expanded/collapsed state — a POS tablet parked at the pass wants different
 * shortcuts from the owner's phone, and both belong to the *device*, not to the
 * business row. Nothing here touches the network.
 */

/**
 * How many pages the bar can hold. The «پروفایل» button that opens the full nav
 * is not one of them — it always occupies the last slot, so the bar shows at
 * most BOTTOM_NAV_MAX + 1 items.
 */
export const BOTTOM_NAV_MAX = 4;

export const BOTTOM_NAV_STORAGE_KEY = "dashboard-bottom-nav";

/** The bar before anyone configures it — the set that shipped before this was a choice. */
const DEFAULT_HREFS = ["/dashboard", "/dashboard/orders", "/dashboard/reports"];
/** On the sell screen, the cashier tab replaces reports so the active workflow stays visible. */
const DEFAULT_POS_HREFS = ["/dashboard", "/dashboard/pos", "/dashboard/orders"];

/** Reads the stored list, tolerating anything a hand-edited localStorage might hold. */
export function parseBottomNavHrefs(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((href): href is string => typeof href === "string");
  } catch {
    return null;
  }
}

/**
 * The hrefs the bar should render.
 *
 * `availableHrefs` is the nav the member can actually see — already filtered by
 * industry, feature flag, role and permission upstream — so a page that stops
 * being visible (a flag switched off, a role changed) silently drops out of a
 * saved bar instead of rendering a link to a 403.
 */
export function resolveBottomNavHrefs(
  stored: string[] | null,
  availableHrefs: string[],
  onSellScreen: boolean,
): string[] {
  const preferred = stored?.length ? stored : onSellScreen ? DEFAULT_POS_HREFS : DEFAULT_HREFS;
  const picked = preferred.filter((href) => availableHrefs.includes(href));
  // Deduped because the stored value is user-writable and two identical hrefs
  // would render two links with the same React key.
  return [...new Set(picked)].slice(0, BOTTOM_NAV_MAX);
}

/** Checkbox behaviour for the picker: toggles off freely, refuses to add past the cap. */
export function toggleBottomNavHref(current: string[], href: string): string[] {
  if (current.includes(href)) return current.filter((entry) => entry !== href);
  if (current.length >= BOTTOM_NAV_MAX) return current;
  return [...current, href];
}
