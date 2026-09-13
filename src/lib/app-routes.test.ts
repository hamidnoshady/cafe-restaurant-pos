/**
 * The canonical URL table and the legacy redirects.
 *
 * These are the rules the whole move rides on, and each of the cases below is
 * a bug that actually shipped: an app URL that 404'd because middleware
 * rewrote the pathname instead of serving a real route, a bare app prefix that
 * landed on nothing, a section path that had `/overview` appended to it until
 * `/crm/overview` became `/crm/overview/overview`, and deep links that lost
 * their query string on the way through.
 */
import { describe, expect, it } from "vitest";
import {
  APP_HOME_HREFS,
  APP_ROUTE_PREFIXES,
  APP_SETTINGS_HREFS,
  DASHBOARD_HOME,
  PLATFORM_BILLING_HREF,
  PLATFORM_ROUTES,
  PLATFORM_SETTINGS_HOME,
  PLATFORM_SUBSCRIPTION_HREF,
  appPrefixForPathname,
  canonicalPathForLegacy,
  isCanonicalAppPathname,
  isPlatformSettingsPathname,
  legacyRedirectTarget,
} from "./app-routes";

describe("canonical routes", () => {
  it("gives every app a top-level prefix and an overview home", () => {
    for (const prefix of APP_ROUTE_PREFIXES) {
      // Top level: an app is not a folder of the dashboard any more.
      expect(prefix.startsWith("/dashboard")).toBe(false);
      expect(prefix.split("/")).toHaveLength(2);
      // …and its home is its overview page, not the bare prefix, so the app
      // front page has exactly one address.
      expect(APP_HOME_HREFS[prefix]).toBe(`${prefix}/overview`);
    }
  });

  it("gives every app its own settings route, never the platform's", () => {
    for (const prefix of APP_ROUTE_PREFIXES) {
      const href = APP_SETTINGS_HREFS[prefix];
      expect(href).toBe(`${prefix}/settings`);
      // The rule the whole settings split exists for: an app's settings page
      // is inside the app, and is never the platform settings page.
      expect(href).not.toBe(PLATFORM_SETTINGS_HOME);
      expect(isPlatformSettingsPathname(href)).toBe(false);
    }
  });

  it("keeps billing and subscription platform-owned", () => {
    // An app may *link* to these; it must never own a copy of them.
    expect(isPlatformSettingsPathname(PLATFORM_BILLING_HREF)).toBe(true);
    expect(isPlatformSettingsPathname(PLATFORM_SUBSCRIPTION_HREF)).toBe(true);
    expect(appPrefixForPathname(PLATFORM_BILLING_HREF)).toBeNull();
    expect(appPrefixForPathname(PLATFORM_SUBSCRIPTION_HREF)).toBeNull();
    expect(PLATFORM_ROUTES).toContain(PLATFORM_BILLING_HREF);
    expect(PLATFORM_ROUTES).toContain(PLATFORM_SUBSCRIPTION_HREF);
  });

  it("leaves the workspace home where it is", () => {
    expect(DASHBOARD_HOME).toBe("/dashboard");
    expect(appPrefixForPathname(DASHBOARD_HOME)).toBeNull();
    expect(canonicalPathForLegacy(DASHBOARD_HOME)).toBeNull();
  });
});

describe("appPrefixForPathname", () => {
  it("matches whole segments, not string prefixes", () => {
    expect(appPrefixForPathname("/crm")).toBe("/crm");
    expect(appPrefixForPathname("/crm/persons/42")).toBe("/crm");
    expect(appPrefixForPathname("/growthlab")).toBeNull();
    expect(appPrefixForPathname("/accounting-extra")).toBeNull();
    expect(appPrefixForPathname("/login")).toBeNull();
  });
});

describe("legacy redirects", () => {
  it("sends a bare app prefix to that app's overview", () => {
    expect(canonicalPathForLegacy("/dashboard/accounting")).toBe("/accounting/overview");
    expect(canonicalPathForLegacy("/dashboard/growth")).toBe("/growth/overview");
    expect(canonicalPathForLegacy("/dashboard/crm")).toBe("/crm/overview");
    expect(canonicalPathForLegacy("/dashboard/website")).toBe("/websites/overview");
  });

  it("carries a section suffix through verbatim", () => {
    expect(canonicalPathForLegacy("/dashboard/crm/segments")).toBe("/crm/segments");
    expect(canonicalPathForLegacy("/dashboard/growth/gift-cards")).toBe("/growth/gift-cards");
    expect(canonicalPathForLegacy("/dashboard/accounting/entries")).toBe("/accounting/entries");
    expect(canonicalPathForLegacy("/dashboard/pos")).toBe("/accounting/pos");
    expect(canonicalPathForLegacy("/dashboard/stock")).toBe("/accounting/stock");
    expect(canonicalPathForLegacy("/dashboard/products")).toBe("/accounting/products");
    expect(canonicalPathForLegacy("/dashboard/products/new")).toBe("/accounting/products/new");
    expect(canonicalPathForLegacy("/dashboard/products/prices")).toBe("/products/prices");
    expect(canonicalPathForLegacy("/dashboard/cosmetics")).toBe("/accounting/cosmetics");
    expect(canonicalPathForLegacy("/dashboard/reports")).toBe("/accounting/reports");
    // Nested paths and route params survive too — the CRM's customer file was
    // one of the URLs the rewrite table simply did not know about.
    expect(canonicalPathForLegacy("/dashboard/crm/persons/42")).toBe("/crm/persons/42");
    expect(canonicalPathForLegacy("/dashboard/website/wp/orders/7")).toBe("/websites/wp/orders/7");
  });

  it("never appends the home segment to a path that already names a section", () => {
    // The exact regression: `/crm/overview` must not become
    // `/crm/overview/overview`, and it must not be treated as legacy at all.
    expect(canonicalPathForLegacy("/crm/overview")).toBeNull();
    expect(canonicalPathForLegacy("/accounting/overview")).toBeNull();
    expect(canonicalPathForLegacy("/growth/overview")).toBeNull();
    expect(canonicalPathForLegacy("/websites/overview")).toBeNull();
    expect(canonicalPathForLegacy("/dashboard/crm/overview")).toBe("/crm/overview");
    // …and doing it twice is a fixed point, which is what stops a redirect loop.
    for (const home of Object.values(APP_HOME_HREFS)) {
      expect(legacyRedirectTarget(home)).toBeNull();
      expect(isCanonicalAppPathname(home)).toBe(true);
    }
  });

  it("moves the platform's own pages into the settings area", () => {
    expect(canonicalPathForLegacy("/dashboard/settings")).toBe("/settings");
    expect(canonicalPathForLegacy("/dashboard/settings/team")).toBe("/settings/team");
    expect(canonicalPathForLegacy("/dashboard/projects")).toBe("/projects");
    expect(canonicalPathForLegacy("/dashboard/billing")).toBe(PLATFORM_BILLING_HREF);
    expect(canonicalPathForLegacy("/dashboard/connections")).toBe("/settings/connections");
    expect(canonicalPathForLegacy("/dashboard/connections/holoo")).toBe("/settings/connections/holoo");
  });

  it("leaves the workspace's own pages alone", () => {
    for (const pathname of [
      "/dashboard",
      "/dashboard/overview",
      "/dashboard/orders",
      "/dashboard/reports",
      "/dashboard/ai",
      "/dashboard/knowledge",
      "/dashboard/support",
      "/login",
      "/api/orders",
    ]) {
      expect(canonicalPathForLegacy(pathname)).toBeNull();
      expect(legacyRedirectTarget(pathname)).toBeNull();
    }
  });

  it("matches whole segments, so a lookalike route is not redirected", () => {
    expect(canonicalPathForLegacy("/dashboard/crmx")).toBeNull();
    expect(canonicalPathForLegacy("/dashboard/settings-export")).toBeNull();
  });
});

describe("legacyRedirectTarget", () => {
  it("preserves the query string of a deep link", () => {
    expect(legacyRedirectTarget("/dashboard/crm/persons", "?party=42")).toBe("/crm/persons?party=42");
    expect(legacyRedirectTarget("/dashboard/accounting", "?tab=entries")).toBe(
      "/accounting/overview?tab=entries",
    );
    expect(legacyRedirectTarget("/dashboard/settings", "?tab=team")).toBe("/settings?tab=team");
    // Several params, and one carrying an encoded value.
    expect(legacyRedirectTarget("/dashboard/growth/campaigns", "?from=1404-01-01&q=%DA%A9")).toBe(
      "/growth/campaigns?from=1404-01-01&q=%DA%A9",
    );
  });

  it("adds nothing when there is no query string", () => {
    expect(legacyRedirectTarget("/dashboard/crm/segments")).toBe("/crm/segments");
    expect(legacyRedirectTarget("/dashboard/crm/segments", "")).toBe("/crm/segments");
  });
});

describe("isCanonicalAppPathname", () => {
  it("knows the app prefixes, platform settings and projects", () => {
    expect(isCanonicalAppPathname("/accounting/expenses")).toBe(true);
    expect(isCanonicalAppPathname("/websites/cms/content")).toBe(true);
    expect(isCanonicalAppPathname("/settings")).toBe(true);
    expect(isCanonicalAppPathname("/settings/billing")).toBe(true);
    expect(isCanonicalAppPathname("/projects")).toBe(true);
    expect(isCanonicalAppPathname("/projects/42")).toBe(true);
  });

  it("does not claim the workspace's own routes", () => {
    expect(isCanonicalAppPathname("/dashboard")).toBe(false);
    expect(isCanonicalAppPathname("/dashboard/orders")).toBe(false);
    expect(isCanonicalAppPathname("/login")).toBe(false);
  });
});
