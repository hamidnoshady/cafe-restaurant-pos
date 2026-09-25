import { describe, expect, it } from "vitest";
import { CRM_NAV_ITEMS, crmNavItemsFor } from "./crm-nav";
import { roleBasePermissions } from "@/lib/permissions";
import type { Role } from "@/lib/auth";

/**
 * The menu is driven by effective permissions now, not by a role string. These
 * tests still name roles because what they prove is a migration invariant:
 * each built-in preset must see exactly the menu its old role list produced.
 * `of()` is the bridge — the same preset `memberAccessFor` resolves server-side.
 */
function of(role: Role | "none"): ReadonlySet<string> {
  return new Set<string>(role === "none" ? [] : roleBasePermissions(role));
}
import {
  canOpenCrm,
  canViewCrmSection,
  crmCustomerHref,
  crmFallbackHref,
  CRM_SECTION_KEYS,
  crmSectionHref,
  isCrmSectionPathname,
} from "./crm-routes";

describe("CRM_NAV_ITEMS", () => {
  it("lists every navigation destination once and keeps detail pages out of the rail", () => {
    const keys = CRM_NAV_ITEMS.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("persons");
    // Every permanent item remains a real CRM route; the person profile is
    // reached from Contacts and therefore intentionally is not one.
    for (const key of keys) expect(CRM_SECTION_KEYS).toContain(key);
  });

  it("gives each entry a label and a line of help", () => {
    for (const item of CRM_NAV_ITEMS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.description.trim().length).toBeGreaterThan(0);
    }
    const labels = CRM_NAV_ITEMS.map((item) => item.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("is the app's own menu and nothing else's", () => {
    // The CRM owns the sidebar while you are inside it. Its menu must therefore
    // hold only its own routes — no ledger, no growth page, no reports.
    for (const item of CRM_NAV_ITEMS) {
      const href = crmSectionHref(item.key);
      expect(href === "/crm/overview" || href.startsWith("/crm/")).toBe(true);
      expect(href).not.toContain("ledger");
      expect(href).not.toContain("growth");
      expect(href).not.toContain("reports");
    }
  });
});

describe("crmNavItemsFor", () => {
  it("shows owner and manager every permanent CRM destination", () => {
    const permanentKeys = CRM_SECTION_KEYS.filter((key) => key !== "persons");
    for (const role of ["owner", "manager"] as const) {
      expect(crmNavItemsFor(of(role)).map((item) => item.key)).toEqual(permanentKeys);
    }
  });

  it("shows a cashier the floor surface only", () => {
    // The floor keeps exactly what the old flat «مشتریان» page gave it, plus the
    // service desk — the counter is where a complaint is actually heard. It does
    // not get segments, the pipeline, merge or the consent register.
    expect(crmNavItemsFor(of("cashier")).map((item) => item.key)).toEqual([
      "directory",
      "activities",
      "cases",
    ]);
  });

  it("shows someone the app does not admit nothing at all", () => {
    // `crm/layout.tsx` redirects these roles out of the app entirely; a menu of
    // entries that all redirect away would be the same locked door with extra
    // steps. Accountants are on this list on purpose: the CRM posts no journal
    // entries, so there is no accounting reason to read customers' personal data.
    for (const role of ["accountant", "waiter", "kitchen", "none"] as const) {
      expect(crmNavItemsFor(of(role))).toEqual([]);
      expect(canOpenCrm(of(role))).toBe(false);
    }
  });

  it("is permission-honest while treating person files as a Contacts detail", () => {
    for (const role of ["owner", "manager", "cashier", "accountant"] as const) {
      const permissions = of(role);
      const shown = new Set(crmNavItemsFor(permissions).map((item) => item.key));
      for (const key of CRM_SECTION_KEYS.filter((key) => key !== "persons")) {
        expect(shown.has(key)).toBe(canViewCrmSection(permissions, key));
      }
      expect(shown.has("persons")).toBe(false);
    }
  });
});

describe("crmFallbackHref", () => {
  it("keeps a cashier inside the app when they land on a management page", () => {
    // Being thrown to `/dashboard` from a link someone sent you reads as a bug
    // rather than as a permission boundary.
    expect(crmFallbackHref(of("cashier"))).toBe("/crm/directory");
  });

  it("sends someone with no business here back to the dashboard", () => {
    expect(crmFallbackHref(of("accountant"))).toBe("/dashboard");
  });

  it("follows an override rather than the preset it came from", () => {
    // The reason the menu stopped reading `role`: granting one capability to
    // one person must light the menu up for that person alone.
    const cashierPlusPipeline = new Set([...of("cashier"), "crm.view"]);
    expect(crmNavItemsFor(cashierPlusPipeline).map((i) => i.key)).toContain("deals");
    // And revoking one closes that door without touching the rest.
    const managerMinusConsent = new Set(
      [...of("manager")].filter((p) => p !== "crm.consent_manage"),
    );
    expect(crmNavItemsFor(managerMinusConsent).map((i) => i.key)).not.toContain("consent");
    expect(crmNavItemsFor(managerMinusConsent).map((i) => i.key)).toContain("deals");
  });
});

describe("isCrmSectionPathname", () => {
  it("lights the overview only on the app's root", () => {
    // Every section lives under the root path, so a prefix match would leave
    // «میز کار ارتباط با مشتری» active on all nine pages.
    expect(isCrmSectionPathname("/crm/overview", "overview")).toBe(true);
    expect(isCrmSectionPathname("/crm/segments", "overview")).toBe(false);
  });

  it("keeps a section active on its page and anything nested under it", () => {
    expect(isCrmSectionPathname("/crm/deals", "deals")).toBe(true);
    expect(isCrmSectionPathname("/crm/segments", "deals")).toBe(false);
    expect(isCrmSectionPathname("/dashboard/ledger", "directory")).toBe(false);
  });

  it("keeps Contacts lit on one customer's file", () => {
    // A profile is a detail of Contacts, not a permanent peer in the sidebar.
    const href = crmCustomerHref("c-42");
    expect(href).toBe("/crm/persons/c-42");
    expect(isCrmSectionPathname(href, "persons")).toBe(true);
    expect(isCrmSectionPathname(href, "directory")).toBe(true);
  });
});
