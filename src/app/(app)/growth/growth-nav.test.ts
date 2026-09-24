import { describe, expect, it } from "vitest";
import { GROWTH_NAV_ITEMS, growthNavItemsFor } from "./growth-nav";
import { roleBasePermissions } from "@/lib/permissions";
import type { Role } from "@/lib/auth";
import {
  canOpenGrowth,
  canViewGrowthSection,
  GROWTH_SECTION_KEYS,
  growthFallbackHref,
  growthSectionHref,
  isGrowthSectionPathname,
} from "./growth-routes";

/**
 * The menu is driven by effective permissions, not by a role string. These
 * tests still name roles because the point being proved is a migration
 * invariant: each built-in preset must see exactly the menu its old
 * `requireRole` list produced. `of()` is the bridge — the same preset the
 * server resolves through `memberAccessFor`.
 */
function of(role: Role | "none"): ReadonlySet<string> {
  return new Set<string>(role === "none" ? [] : roleBasePermissions(role));
}

describe("GROWTH_NAV_ITEMS", () => {
  it("lists every section of the app, exactly once, in menu order", () => {
    // A new engine (CRM, messaging, the website manager) that lands without a
    // menu entry is invisible; this fails until it is seated in the app's rail.
    expect(GROWTH_NAV_ITEMS.map((item) => item.key)).toEqual([...GROWTH_SECTION_KEYS]);
  });

  it("gives each entry a label and a line of help", () => {
    for (const item of GROWTH_NAV_ITEMS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.description.trim().length).toBeGreaterThan(0);
    }
    const labels = GROWTH_NAV_ITEMS.map((item) => item.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("is the app's own menu and nothing else's", () => {
    // The complaint this answers: the growth screens were being reached through
    // the accounting sidebar. So the app's menu must hold only its own routes —
    // no ledger, no reports, no other app's page.
    for (const item of GROWTH_NAV_ITEMS) {
      const href = growthSectionHref(item.key);
      expect(href === "/growth/overview" || href.startsWith("/growth/")).toBe(true);
      expect(href).not.toContain("ledger");
      expect(href).not.toContain("reports");
    }
  });
});

describe("growthNavItemsFor", () => {
  it("shows owner and manager the whole app", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(growthNavItemsFor(of(role)).map((item) => item.key)).toEqual([
        ...GROWTH_SECTION_KEYS,
      ]);
    }
  });

  it("shows a cashier only the loyalty desk, and never a page they are redirected off", () => {
    // The menu and the route guard must agree exactly: an entry that leads to a
    // redirect is a button that does nothing. The customers screen is a
    // management surface, not a cashier Growth workflow — which is why the
    // cashier preset carries `loyalty.view` and not `growth.view`.
    expect(growthNavItemsFor(of("cashier")).map((item) => item.key)).toEqual(["loyalty"]);
  });

  it("shows someone the app does not admit nothing at all", () => {
    // `growth/layout.tsx` redirects them out of the app; a menu with entries
    // that all redirect away would be the same door with extra steps.
    for (const role of ["waiter", "kitchen", "none"] as const) {
      expect(growthNavItemsFor(of(role))).toEqual([]);
    }
    expect(growthNavItemsFor(of("accountant")).map((item) => item.key)).toEqual(["customers"]);
  });

  it("is the same gate the pages enforce", () => {
    for (const role of ["owner", "manager", "cashier", "accountant", "viewer"] as const) {
      const permissions = of(role);
      const shown = new Set(growthNavItemsFor(permissions).map((item) => item.key));
      for (const key of GROWTH_SECTION_KEYS) {
        expect(shown.has(key)).toBe(canViewGrowthSection(permissions, key));
      }
    }
  });

  it("follows an override, not the preset it came from", () => {
    // The whole reason the menu stopped reading `role`: granting a capability
    // to one person has to light the menu up for that person alone.
    const cashierPlusCampaigns = new Set([...of("cashier"), "growth.manage", "growth.view"]);
    expect(growthNavItemsFor(cashierPlusCampaigns).map((item) => item.key)).toEqual([
      ...GROWTH_SECTION_KEYS,
    ]);
    // And revoking one closes the door without touching the rest.
    const managerMinusLoyalty = new Set(
      [...of("manager")].filter((p) => p !== "loyalty.view" && p !== "loyalty.manage"),
    );
    expect(growthNavItemsFor(managerMinusLoyalty).map((item) => item.key)).not.toContain("loyalty");
  });
});

describe("customer data projection", () => {
  it("opens the customer section in Growth without moving ownership", () => {
    expect(growthSectionHref("customers")).toBe("/growth/customers");
    expect(canViewGrowthSection(of("accountant"), "customers")).toBe(true);
    expect(canOpenGrowth(of("accountant"))).toBe(true);
  });
});

describe("growthFallbackHref", () => {
  it("keeps someone inside the app whenever it has a surface for them", () => {
    // The per-page gates this replaces sent an accountant who opened
    // /growth/campaigns to «وفاداری», which an accountant may not open either —
    // a redirect straight into a second redirect.
    expect(growthFallbackHref(of("accountant"))).toBe(growthSectionHref("customers"));
    expect(growthFallbackHref(of("cashier"))).toBe(growthSectionHref("loyalty"));
    expect(growthFallbackHref(of("owner"))).toBe(growthSectionHref("overview"));
    expect(growthFallbackHref(of("manager"))).toBe(growthSectionHref("overview"));
  });

  it("only leaves the app for someone with nothing here", () => {
    for (const role of ["waiter", "kitchen", "none"] as const) {
      expect(canOpenGrowth(of(role))).toBe(false);
      expect(growthFallbackHref(of(role))).toBe("/dashboard");
    }
  });

  it("never sends anyone to a page they would be bounced off again", () => {
    // The invariant the eight hand-written gates kept breaking.
    for (const role of ["owner", "manager", "cashier", "accountant", "viewer"] as const) {
      const permissions = of(role);
      const target = growthFallbackHref(permissions);
      const key = GROWTH_SECTION_KEYS.find((k) => growthSectionHref(k) === target);
      expect(key).toBeDefined();
      expect(canViewGrowthSection(permissions, key!)).toBe(true);
    }
  });
});
