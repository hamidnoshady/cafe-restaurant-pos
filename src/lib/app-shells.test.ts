import { describe, expect, it } from "vitest";
import { APPS, appForKey } from "./apps";
import { APP_SHELLS, appShellForPathname, isInsideAnyAppShell } from "./app-shells";

describe("appShellForPathname", () => {
  it("hands Growth & Marketing's routes to the growth shell", () => {
    // The app root and every section of it — the sidebar is the app's, at every
    // route under the prefix, so no section page falls back to the business nav.
    expect(appShellForPathname("/growth")?.app).toBe("growth");
    expect(appShellForPathname("/growth/overview")?.app).toBe("growth");
    for (const section of ["campaigns", "gift-cards", "loyalty", "commission"]) {
      expect(appShellForPathname(`/growth/${section}`)?.app).toBe("growth");
    }
    // …and a page nested deeper still, the way a detail route would be.
    expect(appShellForPathname("/growth/campaigns/12")?.app).toBe("growth");
  });

  it("hands both website managers to the one website shell", () => {
    expect(appShellForPathname("/websites")?.app).toBe("website");
    // The CMS manager…
    for (const section of ["setup", "content", "store", "settings", "billing"]) {
      expect(appShellForPathname(`/websites/cms/${section}`)?.app).toBe("website");
    }
    // …and the WordPress/WooCommerce manager, now inside the same app. No
    // `connections` section: the store connection lives in the «اتصال‌های
    // فنی» hub, and the old path redirects there — but a redirect is still
    // under this prefix, so it still wears this shell.
    for (const section of ["products", "orders", "customers", "content", "queue"]) {
      expect(appShellForPathname(`/websites/wp/${section}`)?.app).toBe("website");
    }
    expect(appShellForPathname("/websites/wp/connections")?.app).toBe("website");
  });

  it("leaves every other dashboard route to the business nav", () => {
    // The point of the change is one-directional: حسابداری keeps the nav the
    // business knows, and the workspace home keeps its rail.
    for (const pathname of [
      "/dashboard",
      "/dashboard/overview",
      "/dashboard/ledger",
      "/dashboard/reports",
      "/dashboard/loyalty",
      "/dashboard/commission",
      "/dashboard/projects",
      "/dashboard/settings",
      "/dashboard/connections",
    ]) {
      expect(appShellForPathname(pathname)).toBeNull();
    }
  });

  it("matches whole path segments, not string prefixes", () => {
    // A route that merely starts with the same letters is a different app.
    expect(appShellForPathname("/growthlab")).toBeNull();
    expect(appShellForPathname("/dashboard")).toBeNull();
    expect(appShellForPathname("/growth-extra")).toBeNull();
  });

  it("labels the shell with the app's own name from the registry", () => {
    // One name per app, in the rail, the sidebar and the page header. A shell
    // inventing its own spelling is how two menus start calling one app two things.
    for (const shell of APP_SHELLS) {
      expect(appForKey(shell.app).label).toBe(shell.label);
    }
  });

  it("registers each shell against a real app and its public route", () => {
    const apps = new Set(APPS.map((app) => app.key));
    const publicHomes = {
      growth: "/growth",
      crm: "/crm",
      website: "/websites",
    } as const;

    for (const shell of APP_SHELLS) {
      expect(apps.has(shell.app)).toBe(true);
      // The browser-facing routes are app-first. Middleware rewrites these to
      // the dashboard implementation tree without changing the address bar.
      expect(shell.prefix).toBe(publicHomes[shell.app as keyof typeof publicHomes]);
    }
  });
});

describe("isInsideAnyAppShell", () => {
  it("drops the entries an app owns out of the flat business nav", () => {
    // The entry that made the app look like a page of accounting…
    expect(isInsideAnyAppShell("/growth")).toBe(true);
    expect(isInsideAnyAppShell("/growth/campaigns")).toBe(true);
    // …and nothing else. The old flat pages are redirects, not nav entries, and
    // the accounting suite stays exactly as it was.
    expect(isInsideAnyAppShell("/dashboard/loyalty")).toBe(false);
    expect(isInsideAnyAppShell("/dashboard/ledger")).toBe(false);
    expect(isInsideAnyAppShell("/dashboard/reports")).toBe(false);
  });
});
