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
] as const;

export type GrowthSectionKey = (typeof GROWTH_SECTION_KEYS)[number];

/** The route of Growth's customer data projection. */
export function growthCustomerHref(customerId?: string): string {
  return customerId
    ? `/dashboard/growth/customers?customerId=${encodeURIComponent(customerId)}`
    : "/dashboard/growth/customers";
}

/** The route for a section. The overview is the app root; the rest nest under it. */
export function growthSectionHref(key: GrowthSectionKey): string {
  return key === "overview" ? "/dashboard/growth" : `/dashboard/growth/${key}`;
}

/**
 * Whether a given role may open a section. The Growth app mirrors the
 * accounting suite's rule: compensation data (commission, the management
 * dashboard) is owner/manager, while loyalty is the one surface a cashier works
 * in.
 */
export function canViewGrowthSection(role: string, key: GrowthSectionKey): boolean {
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
 * Whether a dashboard path is a given section — the app's own sidebar's idea of
 * "you are here". The overview is the app root, so it is *only* active on
 * `/dashboard/growth` itself; a section lights up on its page and anything
 * nested under it. Without the exact match on the root, every section page would
 * highlight «میز کار رشد» as well and the menu would have two answers.
 */
export function isGrowthSectionPathname(pathname: string, key: GrowthSectionKey): boolean {
  const href = growthSectionHref(key);
  return key === "overview"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}
