import { describe, expect, it } from "vitest";
import { GROWTH_NAV_ITEMS, growthNavItemsForRole } from "./growth-nav";
import { canViewGrowthSection, GROWTH_SECTION_KEYS, growthSectionHref, isGrowthSectionPathname } from "./growth-routes";

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
      expect(href === "/dashboard/growth" || href.startsWith("/dashboard/growth/")).toBe(true);
      expect(href).not.toContain("ledger");
      expect(href).not.toContain("reports");
    }
  });
});

describe("growthNavItemsForRole", () => {
  it("shows owner and manager the whole app", () => {
    for (const role of ["owner", "manager"]) {
      expect(growthNavItemsForRole(role).map((item) => item.key)).toEqual([...GROWTH_SECTION_KEYS]);
    }
  });

  it("shows a cashier only the floor surface, and never a page they are redirected off", () => {
    // The menu and the route guard must agree exactly: an entry that leads to a
    // redirect is a button that does nothing.
    expect(growthNavItemsForRole("cashier").map((item) => item.key)).toEqual(["loyalty"]);
  });

  it("shows a role the app does not admit nothing at all", () => {
    // `growth/layout.tsx` redirects these roles out of the app; a menu with
    // entries that all redirect away would be the same door with extra steps.
    for (const role of ["accountant", "waiter", "kitchen", ""]) {
      expect(growthNavItemsForRole(role)).toEqual([]);
    }
  });

  it("is the same gate the pages enforce", () => {
    for (const role of ["owner", "manager", "cashier"]) {
      const shown = new Set(growthNavItemsForRole(role).map((item) => item.key));
      for (const key of GROWTH_SECTION_KEYS) {
        expect(shown.has(key)).toBe(canViewGrowthSection(role, key));
      }
    }
  });
});

describe("isGrowthSectionPathname", () => {
  it("lights the overview only on the app's root", () => {
    // Every section page lives under the root path, so a prefix match here would
    // leave «میز کار رشد» active on all five pages.
    expect(isGrowthSectionPathname("/dashboard/growth", "overview")).toBe(true);
    expect(isGrowthSectionPathname("/dashboard/growth/campaigns", "overview")).toBe(false);
  });

  it("keeps a section active on its page and anything nested under it", () => {
    expect(isGrowthSectionPathname("/dashboard/growth/gift-cards", "gift-cards")).toBe(true);
    expect(isGrowthSectionPathname("/dashboard/growth/gift-cards/41", "gift-cards")).toBe(true);
    expect(isGrowthSectionPathname("/dashboard/growth/loyalty", "gift-cards")).toBe(false);
    expect(isGrowthSectionPathname("/dashboard/ledger", "campaigns")).toBe(false);
  });
});
