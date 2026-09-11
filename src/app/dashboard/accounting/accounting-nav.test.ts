import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_ROLES,
  ACCOUNTING_SECTIONS,
  accountingSectionsForRole,
  canViewAccountingSection,
} from "./accounting-nav";
import {
  ACCOUNTING_SECTION_KEYS,
  accountingCustomerHref,
  accountingCustomersHref,
  accountingSectionForLegacyTab,
  accountingSectionHref,
  isAccountingSectionKey,
  isAccountingSectionPathname,
} from "./accounting-routes";

describe("ACCOUNTING_SECTIONS", () => {
  it("lists every section exactly once, dashboard first", () => {
    const keys = ACCOUNTING_SECTIONS.map((section) => section.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("dashboard");
    // …and the menu cannot invent a section the routes do not know.
    expect(keys).toEqual([...ACCOUNTING_SECTION_KEYS]);
  });

  it("gives every entry a non-empty label", () => {
    for (const section of ACCOUNTING_SECTIONS) {
      expect(section.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("points every section at the app's own route prefix", () => {
    // The Accounting app has its own address now — `/accounting/…` —
    // one real route per section, never a `?tab=` on the old ledger page and
    // never another app's page.
    for (const section of ACCOUNTING_SECTIONS) {
      const href = accountingSectionHref(section.key);
      if (section.key === "dashboard") {
        expect(href).toBe("/accounting/overview");
      } else {
        expect(href.startsWith("/accounting/")).toBe(true);
        expect(href).not.toContain("?");
      }
    }
  });

  it("names the persons section the directory route, inside accounting", () => {
    expect(accountingSectionHref("directory")).toBe("/accounting/directory");
    // The customers-only slice is accounting's own page too — the A/R customer
    // links land here, never on a CRM redirect.
    expect(accountingSectionHref("customers")).toBe("/accounting/customers");
    expect(accountingCustomersHref()).toBe("/accounting/customers");
    expect(accountingCustomerHref("p1")).toBe("/accounting/customers?party=p1");
  });
});

describe("accountingSectionsForRole", () => {
  it("shows owner, manager and accountant the whole app", () => {
    expect(accountingSectionsForRole("owner").map((s) => s.key)).toEqual(ACCOUNTING_SECTIONS.map((s) => s.key));
    expect(accountingSectionsForRole("accountant").map((s) => s.key)).toEqual(ACCOUNTING_SECTIONS.map((s) => s.key));
  });

  it("hides payroll from a manager but keeps the rest", () => {
    const keys = accountingSectionsForRole("manager").map((s) => s.key);
    expect(keys).not.toContain("payroll");
    expect(keys).toContain("trial-balance");
    expect(keys).toContain("directory");
    expect(keys).toContain("dashboard");
  });

  it("shows nothing to a role the app already refuses", () => {
    for (const role of ["cashier", "waiter", "kitchen", ""]) {
      expect(accountingSectionsForRole(role)).toEqual([]);
      for (const key of ACCOUNTING_SECTION_KEYS) {
        expect(canViewAccountingSection(role, key)).toBe(false);
      }
    }
  });

  it("agrees with ACCOUNTING_ROLES, the app's own door", () => {
    for (const role of ACCOUNTING_ROLES) {
      expect(accountingSectionsForRole(role).length).toBeGreaterThan(0);
    }
  });
});

describe("isAccountingSectionKey", () => {
  it("accepts the known keys and rejects the unknown", () => {
    expect(isAccountingSectionKey("cheques")).toBe(true);
    expect(isAccountingSectionKey("directory")).toBe(true);
    expect(isAccountingSectionKey("nonsense")).toBe(false);
    expect(isAccountingSectionKey(null)).toBe(false);
  });
});

describe("accountingSectionForLegacyTab", () => {
  it("answers every old `?tab=` target with the section it names now", () => {
    expect(accountingSectionForLegacyTab("cheques")).toBe("cheques");
    expect(accountingSectionForLegacyTab("customers")).toBe("customers");
    // The one rename: the persons tab is the directory route.
    expect(accountingSectionForLegacyTab("parties")).toBe("directory");
  });

  it("lands an unknown or missing tab on the app's home", () => {
    expect(accountingSectionForLegacyTab("nonsense")).toBe("dashboard");
    expect(accountingSectionForLegacyTab(null)).toBe("dashboard");
    expect(accountingSectionForLegacyTab(undefined)).toBe("dashboard");
  });
});

describe("isAccountingSectionPathname", () => {
  it("lights the dashboard only on the app root, sections on their own routes", () => {
    expect(isAccountingSectionPathname("/accounting/overview", "dashboard")).toBe(true);
    expect(isAccountingSectionPathname("/accounting/directory", "dashboard")).toBe(false);
    expect(isAccountingSectionPathname("/accounting/directory", "directory")).toBe(true);
    // What nests under a section is that section's.
    expect(isAccountingSectionPathname("/accounting/customers/x", "customers")).toBe(true);
    // …and the old address never lights a section.
    expect(isAccountingSectionPathname("/dashboard/ledger", "directory")).toBe(false);
  });
});
