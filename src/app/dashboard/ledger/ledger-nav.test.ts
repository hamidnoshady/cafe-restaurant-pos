import { describe, expect, it } from "vitest";
import {
  isLedgerTabKey,
  LEDGER_TABS,
  ledgerTabHref,
  ledgerTabsForRole,
} from "./ledger-nav";

describe("LEDGER_TABS", () => {
  it("lists every section exactly once, dashboard first", () => {
    const keys = LEDGER_TABS.map((tab) => tab.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("dashboard");
  });

  it("gives every entry a non-empty label", () => {
    for (const tab of LEDGER_TABS) {
      expect(tab.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("points every section at the ledger's tabbed route", () => {
    for (const tab of LEDGER_TABS) {
      const href = ledgerTabHref(tab.key);
      expect(href.startsWith("/dashboard/ledger")).toBe(true);
      expect(href).toContain(`tab=${tab.key}`);
    }
  });
});

describe("ledgerTabsForRole", () => {
  it("shows owner, manager and accountant the whole ledger", () => {
    expect(ledgerTabsForRole("owner").map((t) => t.key)).toEqual(LEDGER_TABS.map((t) => t.key));
    expect(ledgerTabsForRole("accountant").map((t) => t.key)).toEqual(LEDGER_TABS.map((t) => t.key));
  });

  it("hides payroll from a manager but keeps the rest", () => {
    const keys = ledgerTabsForRole("manager").map((t) => t.key);
    expect(keys).not.toContain("payroll");
    expect(keys).toContain("trial-balance");
    expect(keys).toContain("dashboard");
  });

  it("shows nothing to a role the ledger page already refuses", () => {
    for (const role of ["cashier", "waiter", "kitchen", ""]) {
      expect(ledgerTabsForRole(role)).toEqual([]);
    }
  });
});

describe("isLedgerTabKey", () => {
  it("accepts the known keys and rejects the unknown", () => {
    expect(isLedgerTabKey("cheques")).toBe(true);
    expect(isLedgerTabKey("dashboard")).toBe(true);
    expect(isLedgerTabKey("nonsense")).toBe(false);
    expect(isLedgerTabKey(null)).toBe(false);
  });
});
