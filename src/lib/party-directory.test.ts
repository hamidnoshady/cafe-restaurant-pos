import { describe, expect, it } from "vitest";
import {
  PARTY_DIRECTORY_HREF,
  PARTY_DIRECTORY_VIEWS,
  PARTY_DIRECTORY_VIEW_KEYS,
  directoryFilterCategories,
  isPartyDirectoryViewKey,
  partyDirectoryHref,
  partyDirectoryView,
  partyDirectoryViewForRole,
} from "./party-directory";
import { PARTY_ROLES } from "./parties";
import { PARTY_SCOPES_DEF } from "./parties-scopes";

/**
 * One directory, several views.
 *
 * The product used to have four people screens — «اشخاص»، «مشتریان»،
 * «تأمین‌کنندگان»، «فروشندگان» — four routes and four sidebar rows over one
 * `parties` table. These assertions are the promise that they are one screen
 * with filters now: one address, one add/edit flow, and a deep link per view
 * so the apps that used to own a screen still land on the right list.
 */

describe("the directory's views", () => {
  it("defines exactly the views it names, «همه اشخاص» first", () => {
    expect(PARTY_DIRECTORY_VIEWS.map((view) => view.key)).toEqual([...PARTY_DIRECTORY_VIEW_KEYS]);
    expect(PARTY_DIRECTORY_VIEWS[0].key).toBe("all");
  });

  it("covers the four words the product uses, plus staff", () => {
    const labels = PARTY_DIRECTORY_VIEWS.map((view) => view.label);
    expect(labels).toEqual(["همه اشخاص", "مشتریان", "تأمین‌کنندگان", "فروشندگان", "کارکنان"]);
  });

  it("gives every view a non-empty, known role set and a sane default", () => {
    for (const view of PARTY_DIRECTORY_VIEWS) {
      expect(view.roles.length).toBeGreaterThan(0);
      for (const role of view.roles) expect(PARTY_ROLES).toContain(role);
      expect(view.defaultRoles.length).toBeGreaterThan(0);
      // A person created from a view holds the role that view is about.
      for (const role of view.defaultRoles) expect(view.roles).toContain(role);
      expect(view.description).toBeTruthy();
    }
  });

  it("makes «همه اشخاص» genuinely everyone", () => {
    expect([...partyDirectoryView("all").roles].sort()).toEqual([...PARTY_ROLES].sort());
  });

  it("keeps «فروشندگان» the same record as «تأمین‌کنندگان» — a word, not a store", () => {
    expect(partyDirectoryView("vendors").roles).toEqual(partyDirectoryView("suppliers").roles);
  });

  it("falls back to the whole directory for an unknown or missing view", () => {
    expect(partyDirectoryView(undefined).key).toBe("all");
    expect(partyDirectoryView(null).key).toBe("all");
    expect(partyDirectoryView("nope").key).toBe("all");
    expect(isPartyDirectoryViewKey("customers")).toBe(true);
    expect(isPartyDirectoryViewKey("nope")).toBe(false);
  });
});

describe("directory links", () => {
  it("gives the default view exactly one address", () => {
    // `?view=all` would make one screen have two URLs.
    expect(partyDirectoryHref()).toBe(PARTY_DIRECTORY_HREF);
    expect(partyDirectoryHref("all")).toBe(PARTY_DIRECTORY_HREF);
    expect(partyDirectoryHref(null)).toBe(PARTY_DIRECTORY_HREF);
  });

  it("deep-links a filtered list, and one party's file inside it", () => {
    expect(partyDirectoryHref("customers")).toBe("/accounting/directory?view=customers");
    expect(partyDirectoryHref("suppliers")).toBe("/accounting/directory?view=suppliers");
    expect(partyDirectoryHref("customers", { party: "p1" })).toBe(
      "/accounting/directory?view=customers&party=p1",
    );
    expect(partyDirectoryHref("all", { party: "p1" })).toBe("/accounting/directory?party=p1");
  });

  it("escapes a party id rather than pasting it into the query", () => {
    expect(partyDirectoryHref("customers", { party: "a&b=c" })).toContain("party=a%26b%3Dc");
  });

  it("sends every role to the list that is about it", () => {
    expect(partyDirectoryViewForRole("Customer")).toBe("customers");
    expect(partyDirectoryViewForRole("Supplier")).toBe("suppliers");
    expect(partyDirectoryViewForRole("Employee")).toBe("employees");
  });

  it("lives inside the Accounting app, where the one directory is", () => {
    expect(PARTY_DIRECTORY_HREF.startsWith("/accounting/")).toBe(true);
    // …and it is exactly the accounting scope's own screen, so the nav entry,
    // the scope and the deep links cannot drift apart.
    const accounting = PARTY_SCOPES_DEF.find((def) => def.key === "accounting");
    expect(accounting?.href).toBe(PARTY_DIRECTORY_HREF);
  });
});

describe("no duplicate party screens", () => {
  it("leaves exactly one scope per app that lists people", () => {
    // Before this change Accounting alone had four (`accounting`,
    // `accounting-customers`, `accounting-suppliers`, `accounting-vendors`).
    const byApp = new Map<string, string[]>();
    for (const def of PARTY_SCOPES_DEF) {
      if (!def.app || !def.href.includes("/directory")) continue;
      byApp.set(def.app, [...(byApp.get(def.app) ?? []), def.key]);
    }
    for (const [app, keys] of byApp) {
      expect(keys, `app "${app}" has more than one party screen`).toHaveLength(1);
    }
  });

  it("routes every scope at a real, distinct address", () => {
    const hrefs = PARTY_SCOPES_DEF.map((def) => def.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) expect(href.startsWith("/")).toBe(true);
  });
});

describe("the categories offered as filters", () => {
  const categories = [
    { id: "c1", role: null, isActive: true, name: "همه" },
    { id: "c2", role: "Customer", isActive: true, name: "VIP" },
    { id: "c3", role: "Supplier", isActive: true, name: "روزی" },
    { id: "c4", role: "Customer", isActive: false, name: "بایگانی‌شده" },
    { id: "c5", role: null, isActive: false, name: "قدیمی" },
  ];

  it("offers active categories whose role is listed, or that have no role", () => {
    // The customers view: the shared and the customer-only grouping.
    expect(directoryFilterCategories(categories, ["Customer"]).map((c) => c.id)).toEqual(["c1", "c2"]);
    // The suppliers view: the same shared grouping, the supplier-only one.
    expect(directoryFilterCategories(categories, ["Supplier"]).map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  it("never offers an archived category, whatever its role", () => {
    expect(directoryFilterCategories(categories, ["Customer", "Supplier", "Employee"])).not.toContain(
      expect.objectContaining({ id: "c4" }),
    );
    expect(directoryFilterCategories(categories, PARTY_ROLES).map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps the personnel-only grouping out of a customers list, and in the personnel view", () => {
    const staffCategories = [...categories, { id: "c6", role: "Employee", isActive: true, name: "شیفтик" }];
    expect(directoryFilterCategories(staffCategories, ["Customer"]).map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(directoryFilterCategories(staffCategories, ["Employee"]).map((c) => c.id)).toEqual(["c1", "c6"]);
  });

  it("keeps offering the «همه» categories when the view names no role", () => {
    // A role-less category is for every role, so it survives even a degenerate
    // empty view — while every scoped one is gone, because none is listed.
    expect(directoryFilterCategories(categories, []).map((c) => c.id)).toEqual(["c1"]);
  });
});
