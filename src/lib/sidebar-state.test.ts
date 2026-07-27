import { describe, expect, test } from "vitest";
import { resolveSidebarMode, toggleDashboardSidebarPreference } from "./sidebar-state";

describe("resolveSidebarMode", () => {
  test("keeps the POS workspace fully off-canvas without changing the dashboard preference", () => {
    expect(resolveSidebarMode("/dashboard/pos", "collapsed")).toBe("offcanvas");
    expect(resolveSidebarMode("/dashboard/pos/orders", "expanded")).toBe("offcanvas");
  });

  test("uses the persisted desktop preference on regular dashboard routes", () => {
    expect(resolveSidebarMode("/dashboard/orders", "collapsed")).toBe("collapsed");
    expect(resolveSidebarMode("/dashboard/orders", "expanded")).toBe("expanded");
  });
});

describe("toggleDashboardSidebarPreference", () => {
  test("switches only between the two persisted dashboard sizes", () => {
    expect(toggleDashboardSidebarPreference("expanded")).toBe("collapsed");
    expect(toggleDashboardSidebarPreference("collapsed")).toBe("expanded");
  });
});
