import { describe, expect, it } from "vitest";
import { computeBranchOverviewMetrics } from "@/lib/reports";
import { reportsTabsForRole } from "./reports-nav";

describe("Branch Overview Reports Tab & Navigation", () => {
  it("includes the branches tab only for the owner role", () => {
    const ownerTabs = reportsTabsForRole("owner");
    expect(ownerTabs.some((t) => t.key === "branches")).toBe(true);

    const managerTabs = reportsTabsForRole("manager");
    expect(managerTabs.some((t) => t.key === "branches")).toBe(false);

    const accountantTabs = reportsTabsForRole("accountant");
    expect(accountantTabs.some((t) => t.key === "branches")).toBe(false);
  });
});

describe("Branch Overview Metric Calculations", () => {
  it("calculates revenue share, margins, and ticket size across branches", () => {
    const branch1 = {
      orderCount: 100,
      total: 20_000_000,
      cogs: 8_000_000,
    };
    const branch2 = {
      orderCount: 50,
      total: 10_000_000,
      cogs: 5_000_000,
    };
    const consolidatedTotal = 30_000_000;

    const m1 = computeBranchOverviewMetrics(branch1, consolidatedTotal);
    expect(m1.grossProfit).toBe(12_000_000);
    expect(m1.grossMarginPct).toBe(60);
    expect(m1.avgTicket).toBe(200_000);
    expect(m1.revenueSharePct).toBeCloseTo(66.67, 1);

    const m2 = computeBranchOverviewMetrics(branch2, consolidatedTotal);
    expect(m2.grossProfit).toBe(5_000_000);
    expect(m2.grossMarginPct).toBe(50);
    expect(m2.avgTicket).toBe(200_000);
    expect(m2.revenueSharePct).toBeCloseTo(33.33, 1);
  });

  it("handles branch with 0 orders and 0 revenue gracefully without NaN or Infinity", () => {
    const branchEmpty = {
      orderCount: 0,
      total: 0,
      cogs: 0,
    };
    const m = computeBranchOverviewMetrics(branchEmpty, 0);

    expect(m.grossProfit).toBe(0);
    expect(m.grossMarginPct).toBe(0);
    expect(m.avgTicket).toBe(0);
    expect(m.revenueSharePct).toBe(0);
    expect(Number.isNaN(m.grossMarginPct)).toBe(false);
    expect(Number.isFinite(m.avgTicket)).toBe(true);
  });
});
