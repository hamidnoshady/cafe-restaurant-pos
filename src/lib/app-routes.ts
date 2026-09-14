/**
 * The platform's canonical public URLs, and what the old ones become.
 *
 * The product used to serve every app out of one route tree — `/dashboard/crm`,
 * `/dashboard/growth`, `/dashboard/website`, `/dashboard/settings` — and a
 * later attempt to give each app a top-level address did it by rewriting the
 * public URL back onto that tree inside middleware. A rewrite is the wrong tool
 * for this: it mutates `request.nextUrl.pathname`, so the server renders one
 * pathname while the browser's history (and therefore `usePathname`, every
 * active-nav rule and every client-side `Link` prefetch) holds another. The
 * pages 404'd or resolved to the wrong route depending on whether a visit was
 * a fresh document load or a client navigation.
 *
 * The apps are real route directories now — `src/app/(app)/<app>` — so nothing
 * is rewritten anywhere: the address bar, the server's route resolution and
 * the client router all agree. What is left is a *redirect* table for the URLs
 * that used to work, which is what this module is.
 *
 * Framework-free (no `next`, no `db`) so the Edge middleware, the route
 * helpers and the unit tests all read the same rules.
 */

/** The main platform home. Unchanged — it is the business's own workspace. */
export const DASHBOARD_HOME = "/dashboard";

/**
 * The business work areas that belong to the primary Accounting workspace.
 *
 * These are public paths, not aliases. Every sidebar entry, link and redirect
 * that opens one of these areas must use this table; `/dashboard/<section>` is
 * retained only as a middleware redirect for a saved bookmark. Keeping the
 * canonical names here gives the nav, route tree and redirect table one source
 * of truth instead of letting a second dashboard URL slip back into the app.
 */
export const ACCOUNTING_WORKSPACE_HREFS = {
  pos: "/accounting/pos",
  inventory: "/accounting/inventory",
  products: "/accounting/products",
  cosmetics: "/accounting/cosmetics",
  reports: "/accounting/reports",
  floor: "/accounting/floor",
  kitchen: "/accounting/kitchen",
  reservations: "/accounting/reservations",
  delivery: "/accounting/delivery",
} as const;

/** One products-workspace sub-section, under the one canonical products door. */
export function accountingProductsHref(section?: string): string {
  return section ? `${ACCOUNTING_WORKSPACE_HREFS.products}/${section}` : ACCOUNTING_WORKSPACE_HREFS.products;
}

/** The platform settings area. Never an app's settings — see `APP_SETTINGS_HREFS`. */
export const PLATFORM_SETTINGS_HOME = "/settings";

/** Platform-owned pages that live beside settings rather than inside an app. */
export const PLATFORM_ROUTES = [
  PLATFORM_SETTINGS_HOME,
  "/settings/profile",
  "/settings/billing",
  "/settings/subscription",
  "/settings/team",
  "/settings/security",
  "/settings/notifications",
  "/settings/business",
  // Technical connections are a platform utility, not an app section: every
  // connection surface inside an app links here rather than keeping a copy.
  "/settings/connections",
  "/projects",
] as const;

/** The apps with a top-level public prefix of their own. */
export const APP_ROUTE_PREFIXES = ["/accounting", "/growth", "/crm", "/websites"] as const;
export type AppRoutePrefix = (typeof APP_ROUTE_PREFIXES)[number];

/** Every app's home, which is always its overview — never the bare prefix. */
export const APP_HOME_HREFS: Record<AppRoutePrefix, string> = {
  "/accounting": "/accounting/overview",
  "/growth": "/growth/overview",
  "/crm": "/crm/overview",
  "/websites": "/websites/overview",
};

/**
 * Each app's own settings page. These are separate routes with their own
 * components, titles and descriptions: an app's settings must never render the
 * platform settings page, and must never redirect to `/settings` unless the
 * thing being configured is genuinely platform-owned (billing, subscription,
 * team, security — see `PLATFORM_ROUTES`).
 */
export const APP_SETTINGS_HREFS: Record<AppRoutePrefix, string> = {
  "/accounting": "/accounting/settings",
  "/growth": "/growth/settings",
  "/crm": "/crm/settings",
  "/websites": "/websites/settings",
};

/** Platform billing and subscription, the two money surfaces an app may link to. */
export const PLATFORM_BILLING_HREF = "/settings/billing";
export const PLATFORM_SUBSCRIPTION_HREF = "/settings/subscription";

/**
 * Whether a pathname is inside one of the apps, and which one.
 *
 * Matched on whole path segments: `/growthlab` is not inside `/growth`.
 */
export function appPrefixForPathname(pathname: string): AppRoutePrefix | null {
  for (const prefix of APP_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return prefix;
  }
  return null;
}

/** Whether a pathname is the platform settings area (and not an app's settings). */
export function isPlatformSettingsPathname(pathname: string): boolean {
  return pathname === PLATFORM_SETTINGS_HOME || pathname.startsWith(`${PLATFORM_SETTINGS_HOME}/`);
}

/**
 * The legacy `/dashboard/*` prefixes and the canonical prefix each becomes.
 *
 * Longest first: `/dashboard/website/wp` has to be answered before
 * `/dashboard/website`, or the `wp` manager's URLs lose their manager.
 */
const LEGACY_PREFIX_MAP: readonly (readonly [string, string])[] = [
  ["/dashboard/accounting", "/accounting"],
  // The business work areas now live inside the primary Accounting workspace.
  // These are redirects only: there is no `page.tsx` left below the old
  // dashboard paths, so a stale URL cannot render a second copy of a page.
  // Products owns nested public sections, hence the prefix entry rather than
  // one row per child route. Retail's old `stock` alias intentionally joins
  // the same single inventory door.
  ["/dashboard/pos", ACCOUNTING_WORKSPACE_HREFS.pos],
  ["/dashboard/stock", ACCOUNTING_WORKSPACE_HREFS.inventory],
  ["/dashboard/inventory", ACCOUNTING_WORKSPACE_HREFS.inventory],
  ["/dashboard/products", ACCOUNTING_WORKSPACE_HREFS.products],
  ["/dashboard/cosmetics", ACCOUNTING_WORKSPACE_HREFS.cosmetics],
  ["/dashboard/reports", ACCOUNTING_WORKSPACE_HREFS.reports],
  ["/dashboard/floor", ACCOUNTING_WORKSPACE_HREFS.floor],
  ["/dashboard/kitchen", ACCOUNTING_WORKSPACE_HREFS.kitchen],
  ["/dashboard/reservations", ACCOUNTING_WORKSPACE_HREFS.reservations],
  ["/dashboard/delivery", ACCOUNTING_WORKSPACE_HREFS.delivery],
  // The two platform surfaces that moved into the settings area: money and
  // the technical connections hub. They were never app pages, and they are
  // not app pages now — they are platform settings, addressed as such.
  ["/dashboard/billing", PLATFORM_BILLING_HREF],
  ["/dashboard/connections", "/settings/connections"],
  ["/dashboard/growth", "/growth"],
  ["/dashboard/crm", "/crm"],
  ["/dashboard/website", "/websites"],
  ["/dashboard/projects", "/projects"],
  ["/dashboard/settings", "/settings"],
];

/**
 * Where an old URL goes now, or null when it is not a legacy app URL.
 *
 * Two rules earn their own lines:
 *
 *  - A *bare* app prefix (`/dashboard/crm`) lands on the app's overview,
 *    because the app's home is its overview page.
 *  - A prefix with a suffix keeps the suffix verbatim
 *    (`/dashboard/crm/segments` → `/crm/segments`). It is emphatically **not**
 *    given an extra `/overview`: appending the home segment to a path that
 *    already names a section is what produced `/crm/overview/overview`.
 *
 * The query string is the caller's to carry (see `legacyRedirectTarget`).
 */
export function canonicalPathForLegacy(pathname: string): string | null {
  for (const [legacy, canonical] of LEGACY_PREFIX_MAP) {
    if (pathname === legacy) {
      // The bare app prefix is the app's home page.
      const home = APP_HOME_HREFS[canonical as AppRoutePrefix];
      return home ?? canonical;
    }
    if (pathname.startsWith(`${legacy}/`)) {
      return `${canonical}${pathname.slice(legacy.length)}`;
    }
  }
  return null;
}

/**
 * The full redirect target for a legacy URL, query string preserved.
 *
 * `search` is the raw `?a=b` string (empty when there is none), exactly as
 * `URL.search` gives it, so a deep link's parameters survive the move.
 */
export function legacyRedirectTarget(pathname: string, search = ""): string | null {
  const canonical = canonicalPathForLegacy(pathname);
  return canonical === null ? null : `${canonical}${search}`;
}

/**
 * A canonical URL must never be treated as legacy — the guard that makes
 * `/crm/overview → /crm/overview/overview` unrepresentable rather than merely
 * absent. Exported because it is exactly what the route tests assert.
 */
export function isCanonicalAppPathname(pathname: string): boolean {
  return (
    appPrefixForPathname(pathname) !== null ||
    isPlatformSettingsPathname(pathname) ||
    pathname === "/projects" ||
    pathname.startsWith("/projects/")
  );
}
