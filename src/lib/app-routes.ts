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
 * helpers and the unit tests all read the same rules. The two app-side route
 * modules imported here are framework-free by the same rule, so the Edge
 * middleware can carry them.
 */

import { partyDirectoryHref } from "./party-directory";
import {
  accountingDirectoryViewForLegacySection,
  accountingSectionForLegacyTab,
  accountingSectionHref,
} from "@/app/(app)/accounting/accounting-routes";
import { WP_SECTION_KEYS } from "@/app/(app)/websites/wp/wp-routes";

/** The main platform home. Unchanged — it is the business's own workspace. */
export const DASHBOARD_HOME = "/dashboard";

/**
 * The workspace's own pages, each at a top-level public URL.
 *
 * These used to live under `/dashboard/<page>`; the dashboard route tree now
 * holds exactly one page — `/dashboard` itself — and everything else is a
 * top-level route (or an app section). The old addresses are middleware
 * redirects in `LEGACY_PREFIX_MAP` below, so no bookmark ever 404s.
 */
export const WORKSPACE_TOP_HREFS = {
  overview: "/overview",
  ai: "/ai",
  media: "/media",
  knowledge: "/knowledge",
  support: "/support",
} as const;

/** The top-level workspace routes, for canonical-pathname checks. */
const WORKSPACE_TOP_ROUTES: readonly string[] = Object.values(WORKSPACE_TOP_HREFS);

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
  // The second wave of the same move: the orders queue, the waiter board and
  // the two industry managers were the last operational pages still living
  // under `/dashboard/…`; they are Accounting work areas like the rest.
  orders: "/accounting/orders",
  waiter: "/accounting/waiter",
  jewelry: "/accounting/jewelry",
  watch: "/accounting/watch",
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
  // The workspace's own pages, now top-level routes. `knowledge` first serves
  // its own prefix; the two older aliases (`guides`, `help`) grew into it.
  ["/dashboard/overview", WORKSPACE_TOP_HREFS.overview],
  ["/dashboard/ai", WORKSPACE_TOP_HREFS.ai],
  ["/dashboard/media", WORKSPACE_TOP_HREFS.media],
  ["/dashboard/knowledge", WORKSPACE_TOP_HREFS.knowledge],
  ["/dashboard/support", WORKSPACE_TOP_HREFS.support],
  ["/dashboard/guides", WORKSPACE_TOP_HREFS.knowledge],
  ["/dashboard/help", WORKSPACE_TOP_HREFS.knowledge],
  // The second wave of work areas into Accounting: the orders queue (its
  // `/dashboard/orders/<id>` deep links keep their suffix and land on the
  // `[id]` route, which opens the order's dialog), the waiter board and the
  // two industry managers.
  ["/dashboard/orders", ACCOUNTING_WORKSPACE_HREFS.orders],
  ["/dashboard/waiter", ACCOUNTING_WORKSPACE_HREFS.waiter],
  ["/dashboard/jewelry", ACCOUNTING_WORKSPACE_HREFS.jewelry],
  ["/dashboard/watch", ACCOUNTING_WORKSPACE_HREFS.watch],
  // Phase 42 — the retail trade-goods catalogues live in the shared products
  // workspace; their four old pages were pure redirects and are now rows here.
  ["/dashboard/accessories", ACCOUNTING_WORKSPACE_HREFS.products],
  ["/dashboard/wholesale", ACCOUNTING_WORKSPACE_HREFS.products],
  ["/dashboard/tools-fittings", ACCOUNTING_WORKSPACE_HREFS.products],
  ["/dashboard/haberdashery", ACCOUNTING_WORKSPACE_HREFS.products],
  // Growth & Marketing absorbed the three flat pages (Phase 36b).
  ["/dashboard/loyalty", "/growth/loyalty"],
  ["/dashboard/promotions", "/growth/campaigns"],
  ["/dashboard/commission", "/growth/commission"],
  // The flat persons/customers pages both land on the CRM's directory; a role
  // the CRM does not admit is re-routed by the directory page itself (see
  // `crmFallbackHref` — the accountant lands on Accounting's own directory).
  ["/dashboard/customers", "/crm/directory"],
  ["/dashboard/persons", "/crm/directory"],
  // Platform-owned pages that live in the settings area.
  ["/dashboard/menu", "/settings/menu"],
  ["/dashboard/team", "/settings/team"],
  ["/dashboard/backup", "/settings/backup"],
  ["/dashboard/branches", "/settings/branch-management?branchTab=branches"],
  ["/dashboard/locations", "/settings/branch-management?branchTab=sync"],
  // The old generic integrations pages. Longest first, so the Holoo wizard's
  // URL keeps its own destination (its `?connectionId=` travels as the query).
  ["/dashboard/integrations/holoo", "/settings/connections/holoo"],
  ["/dashboard/integrations", "/settings/connections?tab=woocommerce"],
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
      // A target that carries its own query (`/settings/connections?tab=…`)
      // takes the suffix on the path, before its `?`.
      const query = canonical.indexOf("?");
      const suffix = pathname.slice(legacy.length);
      return query === -1
        ? `${canonical}${suffix}`
        : `${canonical.slice(0, query)}${suffix}${canonical.slice(query)}`;
    }
  }
  return null;
}

/**
 * Joins a redirect target that may already carry a query string with the
 * query string the visitor arrived with. The visitor's parameters win a
 * collision: a `/dashboard/integrations?tab=x` deep link keeps its own tab.
 */
function withSearch(canonical: string, search: string): string {
  if (!search || search === "?") return canonical;
  const extra = search.startsWith("?") ? search.slice(1) : search;
  if (!extra) return canonical;
  return canonical.includes("?") ? `${canonical}&${extra}` : `${canonical}?${extra}`;
}

/**
 * The Accounting app's oldest address — one tabbed page at
 * `/dashboard/ledger?tab=…` — forwarded to the section each tab names now.
 * `parties`/`customers`/`suppliers`/`vendors` became the one directory, so
 * those tabs carry *which list* was asked for, and a `?party=` deep link
 * travels with its file-opening parameter intact.
 */
function legacyLedgerTarget(search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const tab = params.get("tab");
  const party = params.get("party");
  const view = accountingDirectoryViewForLegacySection(tab);
  const section = accountingSectionForLegacyTab(tab);
  if (section === "directory") {
    return partyDirectoryHref(view ?? "all", { party: party ?? null });
  }
  const href = accountingSectionHref(section);
  return party ? `${href}?party=${encodeURIComponent(party)}` : href;
}

/**
 * The standalone WordPress manager's old home (`/dashboard/wp/*`, Phase 40).
 * Every section forwards into «مدیریت وب‌سایت» — except `connections`, the
 * store's technical connection, which lives in the «اتصال‌های فنی» hub. An
 * unknown trailing segment lands on the manager's front page rather than a
 * 404: a URL that used to work never becomes a dead end.
 */
function legacyWpTarget(pathname: string, search: string): string {
  const rest = pathname.slice("/dashboard/wp".length).replace(/^\//, "");
  const [first] = rest.split("/");
  if (first === "connections") return withSearch("/settings/connections?tab=woocommerce", search);
  const known = first && (WP_SECTION_KEYS as readonly string[]).includes(first);
  return withSearch(known ? `/websites/wp/${rest}` : "/websites/wp", search);
}

/**
 * The full redirect target for a legacy URL, query string preserved.
 *
 * `search` is the raw `?a=b` string (empty when there is none), exactly as
 * `URL.search` gives it, so a deep link's parameters survive the move.
 */
export function legacyRedirectTarget(pathname: string, search = ""): string | null {
  // The two old addresses whose targets depend on more than the path: the
  // tabbed ledger page and the standalone WordPress manager.
  if (pathname === "/dashboard/ledger" || pathname.startsWith("/dashboard/ledger/")) {
    return legacyLedgerTarget(search);
  }
  if (pathname === "/dashboard/wp" || pathname.startsWith("/dashboard/wp/")) {
    return legacyWpTarget(pathname, search);
  }
  const canonical = canonicalPathForLegacy(pathname);
  return canonical === null ? null : withSearch(canonical, search);
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
    pathname.startsWith("/projects/") ||
    WORKSPACE_TOP_ROUTES.some(
      (route) => pathname === route || pathname.startsWith(`${route}/`),
    )
  );
}
