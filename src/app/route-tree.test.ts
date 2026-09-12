/**
 * Every public URL the product promises must resolve to a real route file.
 *
 * This is the test the whole routing change exists for. The apps used to be
 * served by rewriting the browser's URL back onto `/dashboard/<app>` inside
 * middleware, and the rewrite table listed only the app roots and their
 * `/overview`. Everything else — `/accounting/expenses`, `/crm/persons/:id`,
 * `/growth/campaigns`, `/websites/cms/content`, `/settings/team` — resolved to
 * nothing and answered 404, and nothing in the suite noticed, because a
 * missing route is not a type error and no unit test walks the filesystem.
 *
 * So this one does: it resolves each promised URL the way Next's app router
 * does (static segment first, then a dynamic `[segment]`, then a catch-all)
 * and asserts a `page.tsx` exists at the end of it. It deliberately checks
 * *resolution*, not rendering — the gates, the data and the chrome all have
 * their own tests — because the failure being prevented is precisely "the
 * address bar says a URL this app has no route for".
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNTING_SECTION_KEYS } from "./(app)/accounting/accounting-routes";
import { CRM_SECTION_KEYS } from "./(app)/crm/crm-routes";
import { GROWTH_SECTION_KEYS } from "./(app)/growth/growth-routes";
import { CMS_SECTION_KEYS, WEBSITE_HOME } from "./(app)/websites/website-routes";
import { WP_SECTION_KEYS } from "./(app)/websites/wp/wp-routes";
import {
  APP_HOME_HREFS,
  APP_ROUTE_PREFIXES,
  APP_SETTINGS_HREFS,
  DASHBOARD_HOME,
  PLATFORM_SETTINGS_HOME,
} from "@/lib/app-routes";
import { PLATFORM_SETTINGS_PAGES, settingsTabHref } from "@/lib/settings-routes";
import { SETTINGS_TAB_KEYS } from "@/lib/settings-tabs";

const APP_DIR = fileURLToPath(new URL("./", import.meta.url));

/** Route groups — `(app)` — are invisible in the URL but real in the tree. */
function groupDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.startsWith("(") && entry.endsWith(")"))
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isDirectory());
}

/** The directory a URL segment resolves to, in the order Next tries them. */
function childFor(dir: string, segment: string): string | null {
  const candidates = [dir, ...groupDirs(dir)];
  for (const base of candidates) {
    const exact = join(base, segment);
    if (existsSync(exact) && statSync(exact).isDirectory()) return exact;
  }
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    const dynamic = readdirSync(base).find(
      (entry) =>
        entry.startsWith("[") &&
        entry.endsWith("]") &&
        statSync(join(base, entry)).isDirectory(),
    );
    if (dynamic) return join(base, dynamic);
  }
  return null;
}

/** Whether the app router would find a page for this pathname. */
function resolves(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  let dir: string | null = APP_DIR;
  for (const segment of segments) {
    dir = childFor(dir, segment);
    if (!dir) return false;
  }
  const bases = [dir, ...groupDirs(dir)];
  return bases.some((base) => existsSync(join(base, "page.tsx")));
}

function expectRoute(pathname: string) {
  expect(resolves(pathname), `${pathname} has no page.tsx — it would 404`).toBe(true);
}

describe("the route tree resolves every promised URL", () => {
  it("finds the workspace home and the platform's own pages", () => {
    for (const pathname of ["/dashboard", "/projects", "/settings", "/login"]) {
      expectRoute(pathname);
    }
  });

  it("finds every app's prefix, home and settings", () => {
    for (const prefix of APP_ROUTE_PREFIXES) {
      expectRoute(prefix);
      expectRoute(APP_HOME_HREFS[prefix]);
      // Each app's own settings page — a real route inside the app, which is
      // what makes "never the platform settings page" possible.
      expectRoute(APP_SETTINGS_HREFS[prefix]);
    }
  });

  it("finds every Accounting section", () => {
    for (const key of ACCOUNTING_SECTION_KEYS) {
      expectRoute(key === "dashboard" ? "/accounting/overview" : `/accounting/${key}`);
    }
  });

  it("finds every CRM section, and a person's file", () => {
    for (const key of CRM_SECTION_KEYS) {
      expectRoute(key === "overview" ? "/crm/overview" : `/crm/${key}`);
    }
    // The dynamic detail routes the old rewrite table never covered.
    expectRoute("/crm/persons/00000000-0000-0000-0000-000000000000");
    expectRoute("/crm/customers/00000000-0000-0000-0000-000000000000");
  });

  it("finds every Growth section", () => {
    for (const key of GROWTH_SECTION_KEYS) {
      expectRoute(key === "overview" ? "/growth/overview" : `/growth/${key}`);
    }
  });

  it("finds both website managers and all their sections", () => {
    expectRoute(`${WEBSITE_HOME}/overview`);
    for (const key of CMS_SECTION_KEYS) {
      expectRoute(key === "overview" ? `${WEBSITE_HOME}/cms` : `${WEBSITE_HOME}/cms/${key}`);
    }
    for (const key of WP_SECTION_KEYS) {
      expectRoute(key === "overview" ? `${WEBSITE_HOME}/wp` : `${WEBSITE_HOME}/wp/${key}`);
    }
  });

  it("finds every platform settings section", () => {
    for (const key of SETTINGS_TAB_KEYS) expectRoute(settingsTabHref(key));
    for (const page of PLATFORM_SETTINGS_PAGES) expectRoute(`/settings/${page}`);
  });

  it("finds the legacy addresses that must keep redirecting rather than 404ing", () => {
    // These pages still exist; they are redirects now. A bookmark, a saved
    // bottom-nav slot or an old guide must land somewhere.
    for (const pathname of [
      "/dashboard/ledger",
      "/dashboard/customers",
      "/dashboard/persons",
      "/dashboard/loyalty",
      "/dashboard/promotions",
      "/dashboard/commission",
      "/dashboard/team",
      "/dashboard/menu",
      "/dashboard/backup",
      "/dashboard/branches",
      "/dashboard/locations",
    ]) {
      expectRoute(pathname);
    }
  });

  it("agrees with the production build, when one has been made", () => {
    // The filesystem walk above proves a `page.tsx` exists; it cannot prove
    // Next actually compiled it into the server bundle. `next build` writes
    // every app route it emitted into this manifest, so when a build is
    // present it is the closest thing to "the deployed server has this URL"
    // that a unit test can read. Skipped when there is no build, so the suite
    // still runs on a fresh clone.
    const manifestPath = fileURLToPath(new URL("../../.next/server/app-paths-manifest.json", import.meta.url));
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
    // Manifest keys keep the `(group)` segments the URL does not have.
    const built = new Set(
      Object.keys(manifest).map(
        (key) =>
          key
            .replace(/\/page$/, "")
            .split("/")
            .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
            .join("/") || "/",
      ),
    );

    /**
     * A URL is served if some built route matches it segment for segment,
     * where a `[dynamic]` segment matches anything — `/accounting/settings`
     * is served by `/accounting/[section]`, which is a real route and not a
     * missing one.
     */
    const servedByBuild = (pathname: string) => {
      const wanted = pathname.split("/").filter(Boolean);
      return [...built].some((route) => {
        const got = route.split("/").filter(Boolean);
        if (got.length !== wanted.length) return false;
        return got.every(
          (segment, i) =>
            (segment.startsWith("[") && segment.endsWith("]")) || segment === wanted[i],
        );
      });
    };

    const promised = [
      DASHBOARD_HOME,
      "/projects",
      PLATFORM_SETTINGS_HOME,
      ...PLATFORM_SETTINGS_PAGES.map((page) => `/settings/${page}`),
      ...APP_ROUTE_PREFIXES.flatMap((prefix) => [
        prefix,
        APP_HOME_HREFS[prefix],
        APP_SETTINGS_HREFS[prefix],
      ]),
    ];
    for (const pathname of promised) {
      expect(servedByBuild(pathname), `${pathname} is not in the production bundle`).toBe(true);
    }
  });

  it("does not resolve a route the product never promised", () => {
    // Guards the resolver itself: a walker that answered "yes" to everything
    // would make every assertion above meaningless.
    expect(resolves("/definitely-not-a-route")).toBe(false);
    expect(resolves("/accounting/overview/overview")).toBe(false);
  });
});
