/**
 * The Growth & Marketing app's section routing (Phase 36b, revised).
 *
 * The app used to be one route with an in-page section rail. It is now a real
 * app with one page per section, and — since the sidebar was handed to it —
 * its own **main** menu in the dashboard's app slot (src/lib/app-shells.ts),
 * rather than a second menu drawn inside the page next to the accounting nav.
 *
 * These keys are the single source of truth for that menu (`growth-nav.ts`
 * labels them) and for the server-side gate. That gate is now expressed in the
 * same `growth.*` capabilities the API enforces rather than in a parallel list
 * of role names — see `canViewGrowthSection`.
 */
import { PERMISSIONS, type Permission } from "@/lib/permissions";

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
 * What a member must hold to open each section.
 *
 * ## This used to be a role list, and it disagreed with the API
 *
 * Every section was gated on `["owner", "manager"].includes(role)` with two
 * hard-coded exceptions, while the routes behind them are gated on
 * `growth.view` / `growth.manage`. The two rules agreed only by coincidence,
 * and the coincidence broke the moment anything moved: an owner who granted
 * `growth.manage` to a salesperson got an API that accepted the request and a
 * menu that never showed the page, and revoking `growth.view` from a manager
 * left every screen visible and every fetch inside it failing with 403.
 *
 * Navigation now asks the same question the API asks. The mapping below
 * reproduces the previous audience exactly for the built-in roles — the
 * accountant and cashier presets carry `growth.view`, and only the owner and
 * manager presets carry `growth.manage` — so nobody's menu changes, but the
 * menu is now *derived* from access rather than parallel to it.
 */
const SECTION_PERMISSION: Record<GrowthSectionKey, Permission> = {
  // The growth dashboard aggregates revenue and campaign performance; it was
  // owner/manager, and `growth.manage` is exactly that audience.
  overview: PERMISSIONS.growthManage,
  // Growth's customer screen is the back-office read the accountant had.
  customers: PERMISSIONS.growthView,
  // The loyalty desk is till work, which is why it is a separate capability.
  loyalty: PERMISSIONS.loyaltyView,
  // Acting: running a campaign, sending messages, issuing gift cards, paying
  // commission, and reconfiguring the app.
  campaigns: PERMISSIONS.growthManage,
  messaging: PERMISSIONS.growthManage,
  "gift-cards": PERMISSIONS.growthManage,
  commission: PERMISSIONS.growthManage,
  settings: PERMISSIONS.growthManage,
};

/** The capability a section needs, for callers that want to state it themselves. */
export function growthSectionPermission(key: GrowthSectionKey): Permission {
  return SECTION_PERMISSION[key];
}

/**
 * Whether a member may open a section, given their effective permissions —
 * the same set `memberAccessFor` resolves and the same one the API enforces.
 */
export function canViewGrowthSection(
  permissions: ReadonlySet<string>,
  key: GrowthSectionKey,
): boolean {
  return permissions.has(SECTION_PERMISSION[key]);
}

/** Whether a member has at least one Growth surface to open. */
export function canOpenGrowth(permissions: ReadonlySet<string>): boolean {
  return GROWTH_SECTION_KEYS.some((key) => canViewGrowthSection(permissions, key));
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
export function growthFallbackHref(permissions: ReadonlySet<string>): string {
  const section = GROWTH_SECTION_KEYS.find((key) => canViewGrowthSection(permissions, key));
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
