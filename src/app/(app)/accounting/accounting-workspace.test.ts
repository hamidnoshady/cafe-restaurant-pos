import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_SECTIONS,
  accountingSectionsForRole,
} from "./accounting-nav";
import { ACCOUNTING_SECTION_KEYS, accountingSectionHref } from "./accounting-routes";
import {
  accountingWorkspaceGroups,
  accountingWorkspaceHrefs,
  LEDGER_WORKSPACE_GROUP_KEY,
  LEDGER_WORKSPACE_LABEL,
  LEDGER_WORKSPACE_SECTION_KEYS,
} from "./accounting-workspace";
import { partyDirectoryHref } from "@/lib/party-directory";

/**
 * Accounting is the business's primary workspace.
 *
 * The regression these assertions exist to prevent is the one they were
 * written for: «حسابداری» opening straight into the ledger rail, with every
 * other work area of the business living in a second main menu at
 * `/dashboard/*`. So the contract is:
 *
 *  1. the menu is a *complete* work menu, not the ledger alone;
 *  2. «فضای کار حسابداری» is a group *inside* it, never the whole thing;
 *  3. the business entries are adopted from the nav the shell already gated —
 *     never re-declared here, so a page the member cannot open cannot appear.
 */

/** A business nav the way the shell hands it over: already filtered, flattened. */
const BUSINESS_NAV = [
  { label: "داشبورد", href: "/dashboard/overview" },
  { label: "سفارش‌ها", href: "/dashboard/orders" },
  { label: "صندوق (فروش)", href: "/dashboard/pos" },
  { label: "ارتباط با مشتری", href: "/crm/overview" },
  { label: "خرید و انبار", href: "/dashboard/stock" },
  { label: "انبار", href: "/dashboard/inventory" },
  { label: "محصولات", href: "/dashboard/products", iconKey: "/dashboard/products" },
  { label: "لیست قیمت", href: "/dashboard/products/prices" },
  { label: "گزارش‌ها", href: "/dashboard/reports" },
  { label: "تنظیمات", href: "/settings" },
  { label: "مرکز آموزش", href: "/dashboard/knowledge" },
];

function groupsFor(role: string, navItems = BUSINESS_NAV) {
  return accountingWorkspaceGroups({ role, navItems });
}

describe("the Accounting workspace menu", () => {
  it("opens on a complete overview, not on the ledger", () => {
    const groups = groupsFor("owner");
    // The very first entry of the very first group is the app's home.
    expect(groups[0].entries[0].href).toBe(accountingSectionHref("dashboard"));
    // …and the ledger is not the first thing in the menu any more.
    expect(groups[0].key).not.toBe(LEDGER_WORKSPACE_GROUP_KEY);
  });

  it("exposes the business's primary work areas, not only the ledger", () => {
    const hrefs = accountingWorkspaceHrefs(groupsFor("owner"));
    for (const expected of [
      "/dashboard/orders",
      "/dashboard/pos",
      "/dashboard/stock",
      "/dashboard/inventory",
      "/dashboard/products",
      "/dashboard/reports",
      "/settings",
    ]) {
      expect(hrefs, `«حسابداری» must expose ${expected} as a primary work area`).toContain(expected);
    }
  });

  it("keeps «فضای کار حسابداری» as one named group inside the menu", () => {
    const groups = groupsFor("owner");
    const ledger = groups.find((group) => group.key === LEDGER_WORKSPACE_GROUP_KEY);
    expect(ledger).toBeDefined();
    expect(ledger?.label).toBe(LEDGER_WORKSPACE_LABEL);
    // A group, not the menu: there is strictly more in the menu than it.
    expect(groups.length).toBeGreaterThan(1);
    // And it holds the financial tools the product promises there.
    const keys = ledger?.entries.map((entry) => entry.section);
    for (const expected of [
      "trial-balance",
      "entries",
      "manual",
      "expenses",
      "fiscal-periods",
      "receivables",
      "payables",
      "receipts",
      "installments",
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it("gives every accounting section a home somewhere in the menu", () => {
    // The ledger group plus the top-level entries must between them account
    // for every section an owner may open — a section with no home is a
    // section that silently vanished from the app.
    const hrefs = new Set(accountingWorkspaceHrefs(groupsFor("owner")));
    for (const section of accountingSectionsForRole("owner")) {
      expect(hrefs, `section "${section.key}" has no entry in the Accounting menu`).toContain(
        accountingSectionHref(section.key),
      );
    }
  });

  it("adopts only pages the shell already granted this member", () => {
    // The same role, a nav with no انبار (a trade that has none, or a member
    // who may not open it): the entry simply is not there. One gate.
    const hrefs = accountingWorkspaceHrefs(
      groupsFor(
        "owner",
        BUSINESS_NAV.filter((item) => item.href !== "/dashboard/inventory"),
      ),
    );
    expect(hrefs).not.toContain("/dashboard/inventory");
    expect(hrefs).toContain("/dashboard/stock");
  });

  it("never adopts a page that is not a work area", () => {
    const hrefs = accountingWorkspaceHrefs(groupsFor("owner"));
    expect(hrefs).not.toContain("/dashboard/knowledge");
  });

  it("respects the per-section role gate", () => {
    // Payroll is owner + accountant (compensation data); a manager's menu has
    // the ledger group without it.
    const managerHrefs = accountingWorkspaceHrefs(groupsFor("manager"));
    expect(managerHrefs).not.toContain(accountingSectionHref("payroll"));
    expect(managerHrefs).toContain(accountingSectionHref("trial-balance"));
    expect(accountingWorkspaceHrefs(groupsFor("owner"))).toContain(accountingSectionHref("payroll"));
  });

  it("gives a role that cannot open the app no menu at all", () => {
    expect(accountingWorkspaceHrefs(groupsFor("cashier"))).toEqual([]);
    expect(accountingWorkspaceHrefs(groupsFor("waiter"))).toEqual([]);
  });

  it("offers exactly one people directory, plus filtered deep links", () => {
    const groups = groupsFor("owner");
    const people = groups.find((group) => group.key === "people");
    expect(people).toBeDefined();
    // One entry per *view*, all of them the one route.
    for (const entry of people!.entries) {
      expect(entry.href.split("?")[0]).toBe(accountingSectionHref("directory"));
    }
    expect(people!.entries.map((entry) => entry.href)).toEqual([
      accountingSectionHref("directory"),
      partyDirectoryHref("customers"),
      partyDirectoryHref("suppliers"),
    ]);
  });

  it("has no duplicate entries — one href, one row", () => {
    const hrefs = accountingWorkspaceHrefs(groupsFor("owner"));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("only marks the long ledger group as collapsible", () => {
    const collapsible = groupsFor("owner").filter((group) => group.collapsible);
    expect(collapsible.map((group) => group.key)).toEqual([LEDGER_WORKSPACE_GROUP_KEY]);
  });
});

describe("the ledger group's own section list", () => {
  it("names only real sections, none of them twice", () => {
    for (const key of LEDGER_WORKSPACE_SECTION_KEYS) {
      expect(ACCOUNTING_SECTION_KEYS).toContain(key);
    }
    expect(new Set(LEDGER_WORKSPACE_SECTION_KEYS).size).toBe(LEDGER_WORKSPACE_SECTION_KEYS.length);
  });

  it("leaves the app-level sections out of it", () => {
    // The home, the directory, the two report views and the settings screen
    // are top-level areas of the workspace — putting them back inside the
    // ledger group is how Accounting became "the ledger" in the first place.
    for (const outside of ["dashboard", "directory", "reports", "growth", "settings"]) {
      expect(LEDGER_WORKSPACE_SECTION_KEYS).not.toContain(outside);
    }
    // Together they are exhaustive: nothing in the app is homeless.
    const accounted = new Set<string>([
      ...LEDGER_WORKSPACE_SECTION_KEYS,
      "dashboard",
      "directory",
      "reports",
      "growth",
      "settings",
    ]);
    for (const section of ACCOUNTING_SECTIONS) {
      expect(accounted, `section "${section.key}" is in no Accounting menu group`).toContain(section.key);
    }
  });
});
