/**
 * The lines between the apps, asserted from the outside.
 *
 * Each app's own suite already checks its own menu. What nothing checked is
 * the rule that spans them: an app's settings entry must point at *its own*
 * settings route, no app's menu may lead into the platform's settings area
 * (billing and the subscription are the platform's, and the only way in is the
 * sidebar's platform menu), and the record each app owns must appear in that
 * app's menu and not in a neighbour's.
 *
 * That is the regression this whole change exists to prevent coming back: the
 * apps used to share one settings page and one `/dashboard/*` tree, so "open
 * the CRM's settings" and "open the platform's settings" were the same URL.
 */
import { describe, expect, it } from "vitest";
import {
  APP_HOME_HREFS,
  APP_ROUTE_PREFIXES,
  APP_SETTINGS_HREFS,
  PLATFORM_BILLING_HREF,
  PLATFORM_SETTINGS_HOME,
  PLATFORM_SUBSCRIPTION_HREF,
  appPrefixForPathname,
  isPlatformSettingsPathname,
} from "./app-routes";
import { ACCOUNTING_NAV_GROUPS, ACCOUNTING_SECTIONS } from "@/app/(app)/accounting/accounting-nav";
import { accountingSectionHref } from "@/app/(app)/accounting/accounting-routes";
import { CRM_NAV_ITEMS } from "@/app/(app)/crm/crm-nav";
import { crmSectionHref } from "@/app/(app)/crm/crm-routes";
import { GROWTH_NAV_ITEMS } from "@/app/(app)/growth/growth-nav";
import { growthSectionHref } from "@/app/(app)/growth/growth-routes";

/** Every app's menu, flattened to the hrefs it offers. */
const APP_MENUS: Record<string, readonly string[]> = {
  "/accounting": ACCOUNTING_SECTIONS.map((section) => accountingSectionHref(section.key)),
  "/crm": CRM_NAV_ITEMS.map((item) => crmSectionHref(item.key)),
  "/growth": GROWTH_NAV_ITEMS.map((item) => growthSectionHref(item.key)),
};

describe("each app's menu stays inside its own app", () => {
  it("points every entry at the app's own prefix", () => {
    for (const [prefix, hrefs] of Object.entries(APP_MENUS)) {
      for (const href of hrefs) {
        expect(appPrefixForPathname(href), `${href} should be inside ${prefix}`).toBe(prefix);
      }
    }
  });

  it("never leads into the platform's settings area", () => {
    for (const [prefix, hrefs] of Object.entries(APP_MENUS)) {
      for (const href of hrefs) {
        expect(
          isPlatformSettingsPathname(href),
          `${prefix}'s menu must not open platform settings (${href})`,
        ).toBe(false);
      }
      expect(hrefs).not.toContain(PLATFORM_BILLING_HREF);
      expect(hrefs).not.toContain(PLATFORM_SUBSCRIPTION_HREF);
      expect(hrefs).not.toContain(PLATFORM_SETTINGS_HOME);
    }
  });

  it("ends with the app's own settings entry", () => {
    for (const [prefix, hrefs] of Object.entries(APP_MENUS)) {
      expect(hrefs.at(-1), `${prefix}'s menu should end with its own settings`).toBe(
        APP_SETTINGS_HREFS[prefix as keyof typeof APP_SETTINGS_HREFS],
      );
    }
  });

  it("starts at the app's home, which is its overview", () => {
    for (const [prefix, hrefs] of Object.entries(APP_MENUS)) {
      expect(hrefs[0]).toBe(APP_HOME_HREFS[prefix as keyof typeof APP_HOME_HREFS]);
    }
  });
});

describe("Accounting's sidebar groups", () => {
  it("gives every section exactly one group, so none can vanish from the menu", () => {
    const grouped = ACCOUNTING_NAV_GROUPS.flatMap((group) => group.keys);
    expect([...grouped].sort()).toEqual(ACCOUNTING_SECTIONS.map((s) => s.key).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});

describe("what each app owns", () => {
  it("keeps the accounting directory in Accounting", () => {
    const keys = ACCOUNTING_SECTIONS.map((section) => section.key);
    for (const owned of ["directory", "customers", "suppliers", "vendors"]) {
      expect(keys).toContain(owned);
    }
  });

  it("keeps the CRM's own records in the CRM", () => {
    const keys = CRM_NAV_ITEMS.map((item) => item.key);
    for (const owned of ["activities", "cases", "deals", "segments", "duplicates", "consent"]) {
      expect(keys).toContain(owned);
    }
    // ...and Growth does not grow a second copy of them.
    const growthKeys = GROWTH_NAV_ITEMS.map((item) => item.key) as string[];
    for (const owned of ["activities", "cases", "deals", "segments", "duplicates", "consent"]) {
      expect(growthKeys).not.toContain(owned);
    }
  });

  it("keeps campaigns, loyalty, messaging, gift cards and commission in Growth", () => {
    const keys = GROWTH_NAV_ITEMS.map((item) => item.key);
    for (const owned of ["campaigns", "loyalty", "messaging", "gift-cards", "commission"]) {
      expect(keys).toContain(owned);
    }
    const crmKeys = CRM_NAV_ITEMS.map((item) => item.key) as string[];
    for (const owned of ["campaigns", "loyalty", "messaging", "gift-cards", "commission"]) {
      expect(crmKeys).not.toContain(owned);
    }
  });

  it("gives each app a settings route of its own, all four distinct", () => {
    const hrefs = APP_ROUTE_PREFIXES.map((prefix) => APP_SETTINGS_HREFS[prefix]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) expect(isPlatformSettingsPathname(href)).toBe(false);
  });
});
