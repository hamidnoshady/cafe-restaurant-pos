import { describe, expect, it } from "vitest";
import { APPS, appForKey } from "./apps";
import { APP_SHELLS, appShellForPathname, isInsideAnyAppShell } from "./app-shells";

describe("appShellForPathname", () => {
  it("hands Growth & Marketing's routes to the growth shell", () => {
    // The app root and every section of it — the sidebar is the app's, at every
    // route under the prefix, so no section page falls back to the business nav.
    expect(appShellForPathname("/dashboard/growth")?.app).toBe("growth");
    for (const section of ["campaigns", "gift-cards", "loyalty", "commission"]) {
      expect(appShellForPathname(`/dashboard/growth/${section}`)?.app).toBe("growth");
    }
    // …and a page nested deeper still, the way a detail route would be.
    expect(appShellForPathname("/dashboard/growth/campaigns/12")?.app).toBe("growth");
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
    ]) {
      expect(appShellForPathname(pathname)).toBeNull();
    }
  });

  it("matches whole path segments, not string prefixes", () => {
    // A route that merely starts with the same letters is a different app.
    expect(appShellForPathname("/dashboard/growthlab")).toBeNull();
    expect(appShellForPathname("/dashboard")).toBeNull();
    expect(appShellForPathname("/dashboard/growth-extra")).toBeNull();
  });

  it("labels the shell with the app's own name from the registry", () => {
    // One name per app, in the rail, the sidebar and the page header. A shell
    // inventing its own spelling is how two menus start calling one app two things.
    for (const shell of APP_SHELLS) {
      expect(appForKey(shell.app).label).toBe(shell.label);
    }
  });

  it("registers each shell against a real app and a route under the dashboard", () => {
    const apps = new Set(APPS.map((app) => app.key));
    for (const shell of APP_SHELLS) {
      expect(apps.has(shell.app)).toBe(true);
      expect(shell.prefix.startsWith("/dashboard/")).toBe(true);
      // The prefix is the app's home route, so the rail's link and the shell's
      // ownership are the same path.
      expect(shell.prefix).toBe(`/dashboard/${shell.app}`);
    }
  });
});

describe("isInsideAnyAppShell", () => {
  it("drops the entries an app owns out of the flat business nav", () => {
    // The entry that made the app look like a page of accounting…
    expect(isInsideAnyAppShell("/dashboard/growth")).toBe(true);
    expect(isInsideAnyAppShell("/dashboard/growth/campaigns")).toBe(true);
    // …and nothing else. The old flat pages are redirects, not nav entries, and
    // the accounting suite stays exactly as it was.
    expect(isInsideAnyAppShell("/dashboard/loyalty")).toBe(false);
    expect(isInsideAnyAppShell("/dashboard/ledger")).toBe(false);
    expect(isInsideAnyAppShell("/dashboard/reports")).toBe(false);
  });
});
