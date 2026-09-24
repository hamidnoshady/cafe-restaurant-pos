/**
 * The Growth & Marketing app's section routing (Phase 36b, revised).
 *
 * The app used to be one route with an in-page section rail. It is now a real
 * app with one page per section, and — since the sidebar was handed to it —
 * its own **main** menu in the dashboard's app slot (src/lib/app-shells.ts),
 * rather than a second menu drawn inside the page next to the accounting nav.
 *
 * These keys are the single source of truth for that menu (`growth-nav.ts`
 * labels them) and for the server-side role gate: a cashier may open only
 * `loyalty`, the one floor surface the old flat pages gave them; the management
 * dashboard and the compensation data stay owner/manager, exactly the way the
 * ledger's payroll tab draws its line.
 */

export const GROWTH_SECTION_KEYS = [
  "overview",
  // Growth's own customers screen: the shared record with Growth's columns,
  // managed here — not a second customer system, and not a redirect to CRM.
  "customers",
  "campaigns",
  // Phase 37b — consent-aware SMS/email templates, outbox campaigns and
  // message-credit statements. It stays in Growth, beside its audience work.
  "messaging",
  "gift-cards",
  "loyalty",
  "commission",
  // Growth's *own* settings. `/settings` is the platform settings area;
  // `/growth/settings` configures this app (campaign defaults, loyalty rules,
  // messaging senders) and is a different route with a different component.
  "settings",
] as const;

export type GrowthSectionKey = (typeof GROWTH_SECTION_KEYS)[number];

/** Growth's own settings page — never the platform settings page. */
export const GROWTH_SETTINGS_HREF = "/growth/settings";

/** The route for a section. The overview is the app root; the rest nest under it. */
export function growthSectionHref(key: GrowthSectionKey): string {
  return key === "overview" ? "/growth/overview" : `/growth/${key}`;
}

/**
 * Whether a given role may open a section. The Growth app mirrors the
 * accounting suite's rule: compensation data (commission, the management
 * dashboard) is owner/manager, while loyalty is the one surface a cashier works
 * in.
 */
export function canViewGrowthSection(role: string, key: GrowthSectionKey): boolean {
  // The app's own settings are management work, like every other configuration
  // surface in the product.
  if (key === "settings") return ["owner", "manager"].includes(role);
  // The customers screen is managed here on the shared record. Accountants keep
  // their read of it; only the 360° file (notes, tags, timeline) remains CRM's.
  if (key === "customers") return ["owner", "manager", "accountant"].includes(role);
  if (role === "cashier") return key === "loyalty";
  return ["owner", "manager"].includes(role);
}

/** Whether a role has at least one Growth surface to open. */
export function canOpenGrowth(role: string): boolean {
  return GROWTH_SECTION_KEYS.some((key) => canViewGrowthSection(role, key));
}

/**
 * Where to send someone who lands on a section they may not open — the
 * counterpart to `crmFallbackHref`.
 *
 * Every Growth page used to hand-roll this, and the eight of them did not
 * agree: `/campaigns`, `/commission` and `/gift-cards` sent a cashier to a
 * hard-coded `"/growth/loyalty"` and everyone else out to `/dashboard`;
 * `/customers` sent *everyone* — including an accountant who has no loyalty
 * access — to `/growth/loyalty`, a page they would immediately be bounced off
 * again; `/messaging` sent everyone to `/growth/overview`, which an accountant
 * may not open either. Each of those is a redirect loop or a wrong door opened
 * by a rule written once per page.
 *
 * The rule, stated once: stay inside the app if there is anything here for you
 * — the first section your role may open, in menu order — and leave for
 * `/dashboard` only when there is not. Being bounced to `/dashboard` from a
 * page you were linked to reads as a bug, not as a permission.
 */
export function growthFallbackHref(role: string): string {
  const section = GROWTH_SECTION_KEYS.find((key) => canViewGrowthSection(role, key));
  return section ? growthSectionHref(section) : "/dashboard";
}

/**
 * Whether a dashboard path is a given section — the app's own sidebar's idea of
 * "you are here". The overview is the app root, so it is *only* active on
 * `/growth/overview` itself; a section lights up on its page and anything
 * nested under it. Without the exact match on the root, every section page would
 * highlight «میز کار رشد» as well and the menu would have two answers.
 */
export function isGrowthSectionPathname(pathname: string, key: GrowthSectionKey): boolean {
  const href = growthSectionHref(key);
  return key === "overview"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}
