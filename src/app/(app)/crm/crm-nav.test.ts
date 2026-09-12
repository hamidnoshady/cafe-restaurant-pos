import { describe, expect, it } from "vitest";
import { CRM_NAV_ITEMS, crmNavItemsForRole } from "./crm-nav";
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
  it("lists every section of the app, exactly once, in menu order", () => {
    // A section added to the router without a menu entry is a page nobody can
    // find; this fails until it is seated in the app's rail.
    expect(CRM_NAV_ITEMS.map((item) => item.key)).toEqual([...CRM_SECTION_KEYS]);
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

describe("crmNavItemsForRole", () => {
  it("shows owner and manager the whole app", () => {
    for (const role of ["owner", "manager"]) {
      expect(crmNavItemsForRole(role).map((item) => item.key)).toEqual([...CRM_SECTION_KEYS]);
    }
  });

  it("shows a cashier the floor surface only", () => {
    // The floor keeps exactly what the old flat «مشتریان» page gave it, plus the
    // service desk — the counter is where a complaint is actually heard. It does
    // not get segments, the pipeline, merge or the consent register.
    expect(crmNavItemsForRole("cashier").map((item) => item.key)).toEqual([
      "directory",
      "persons",
      "activities",
      "cases",
    ]);
  });

  it("shows a role the app does not admit nothing at all", () => {
    // `crm/layout.tsx` redirects these roles out of the app entirely; a menu of
    // entries that all redirect away would be the same locked door with extra
    // steps. Accountants are on this list on purpose: the CRM posts no journal
    // entries, so there is no accounting reason to read customers' personal data.
    for (const role of ["accountant", "waiter", "kitchen", ""]) {
      expect(crmNavItemsForRole(role)).toEqual([]);
      expect(canOpenCrm(role)).toBe(false);
    }
  });

  it("is the same gate the pages enforce", () => {
    // The menu and the server-side redirect must agree exactly: an entry that
    // leads to a redirect is a button that does nothing.
    for (const role of ["owner", "manager", "cashier", "accountant"]) {
      const shown = new Set(crmNavItemsForRole(role).map((item) => item.key));
      for (const key of CRM_SECTION_KEYS) {
        expect(shown.has(key)).toBe(canViewCrmSection(role, key));
      }
    }
  });
});

describe("crmFallbackHref", () => {
  it("keeps a cashier inside the app when they land on a management page", () => {
    // Being thrown to `/dashboard` from a link someone sent you reads as a bug
    // rather than as a permission boundary.
    expect(crmFallbackHref("cashier")).toBe("/crm/directory");
  });

  it("sends a role with no business here back to the dashboard", () => {
    expect(crmFallbackHref("accountant")).toBe("/dashboard");
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

  it("keeps «پروندهٔ مشتری» lit on one customer's file", () => {
    // The file is the reason the nesting rule exists: it is reached by id from
    // half the app, and an unlit sidebar there would make it feel like a
    // different place each time.
    const href = crmCustomerHref("c-42");
    expect(href).toBe("/crm/persons/c-42");
    expect(isCrmSectionPathname(href, "persons")).toBe(true);
    expect(isCrmSectionPathname(href, "directory")).toBe(false);
  });
});
