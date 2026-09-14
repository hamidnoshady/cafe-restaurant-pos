import { describe, expect, it } from "vitest";
import {
  isReportsTabKey,
  REPORTS_TABS,
  reportsTabHref,
  reportsTabsForRole,
} from "./reports-nav";

describe("REPORTS_TABS", () => {
  it("lists every section exactly once, first tab first", () => {
    const keys = REPORTS_TABS.map((tab) => tab.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("standard");
  });

  it("points every section at the reports tabbed route", () => {
    for (const tab of REPORTS_TABS) {
      const href = reportsTabHref(tab.key);
      expect(href.startsWith("/accounting/reports")).toBe(true);
      expect(href).toContain(`tab=${tab.key}`);
    }
  });
});

describe("reportsTabsForRole", () => {
  it("shows the owner the branch comparison too", () => {
    expect(reportsTabsForRole("owner").map((t) => t.key)).toEqual(REPORTS_TABS.map((t) => t.key));
  });

  it("hides the branch comparison from manager and accountant", () => {
    for (const role of ["manager", "accountant"]) {
      const keys = reportsTabsForRole(role).map((t) => t.key);
      expect(keys).not.toContain("branches");
      expect(keys).toContain("standard");
    }
  });

  it("shows nothing to a role the reports page already refuses", () => {
    for (const role of ["cashier", "waiter", "kitchen", ""]) {
      expect(reportsTabsForRole(role)).toEqual([]);
    }
  });
});

describe("isReportsTabKey", () => {
  it("accepts the known keys and rejects the unknown", () => {
    expect(isReportsTabKey("builder")).toBe(true);
    expect(isReportsTabKey("standard")).toBe(true);
    expect(isReportsTabKey("nonsense")).toBe(false);
    expect(isReportsTabKey(null)).toBe(false);
  });
});
