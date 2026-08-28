import { describe, expect, it } from "vitest";
import { routeTools, isAlwaysOnTool, appForTool } from "./ai-tool-routing";

describe("isAlwaysOnTool", () => {
  it("marks the tools that Phase 33 rules depend on as always-on", () => {
    expect(isAlwaysOnTool("find_items")).toBe(true);
    expect(isAlwaysOnTool("describe_app")).toBe(true);
    expect(isAlwaysOnTool("propose_action")).toBe(true);
    expect(isAlwaysOnTool("list_reports")).toBe(true);
    expect(isAlwaysOnTool("run_report")).toBe(true);
  });

  it("does not mark app-specific tools as always-on", () => {
    expect(isAlwaysOnTool("get_menu_performance")).toBe(false);
    expect(isAlwaysOnTool("get_ar_aging")).toBe(false);
    expect(isAlwaysOnTool("get_courier_performance")).toBe(false);
  });
});

describe("appForTool", () => {
  it("maps app-specific tools to their owning app", () => {
    expect(appForTool("get_menu_performance")).toBe("sales");
    expect(appForTool("get_repurchase_candidates")).toBe("growth");
    expect(appForTool("get_reservation_conflicts")).toBe("operations");
    expect(appForTool("get_ar_aging")).toBe("accounting");
  });

  it("returns null for always-on and general-purpose tools", () => {
    expect(appForTool("find_items")).toBeNull();
    expect(appForTool("describe_app")).toBeNull();
    expect(appForTool("propose_action")).toBeNull();
  });
});

describe("routeTools", () => {
  const allTools = [
    "find_items",
    "describe_app",
    "propose_action",
    "list_reports",
    "run_report",
    "get_menu_performance",
    "get_void_pattern",
    "get_waste_history",
    "get_repurchase_candidates",
    "get_staff_commission",
    "get_reservation_conflicts",
    "get_courier_performance",
    "get_ar_aging",
    "get_ap_upcoming",
    "draft_expense_from_receipt",
    "get_bill_split_preview",
    "run_accounting_review",
  ];

  it("returns null when no apps are specified (uncertain → send everything)", () => {
    expect(routeTools(allTools, null)).toBeNull();
    expect(routeTools(allTools, undefined)).toBeNull();
    expect(routeTools(allTools, [])).toBeNull();
  });

  it("includes always-on tools regardless of apps", () => {
    const result = routeTools(allTools, ["accounting"])!;
    expect(result).toContain("find_items");
    expect(result).toContain("describe_app");
    expect(result).toContain("propose_action");
    expect(result).toContain("list_reports");
    expect(result).toContain("run_report");
  });

  it("includes app-specific tools only when their app is in scope", () => {
    const salesOnly = routeTools(allTools, ["sales"])!;
    expect(salesOnly).toContain("get_menu_performance");
    expect(salesOnly).toContain("get_void_pattern");
    expect(salesOnly).toContain("get_waste_history");
    expect(salesOnly).not.toContain("get_ar_aging");
    expect(salesOnly).not.toContain("get_reservation_conflicts");
    expect(salesOnly).not.toContain("get_repurchase_candidates");
  });

  it("includes tools from multiple apps when multiple are in scope", () => {
    const result = routeTools(allTools, ["sales", "accounting"])!;
    expect(result).toContain("get_menu_performance");
    expect(result).toContain("get_ar_aging");
    expect(result).not.toContain("get_reservation_conflicts");
    expect(result).not.toContain("get_repurchase_candidates");
  });

  it("includes general-purpose tools (not in map) always", () => {
    const toolsWithGeneral = [...allTools, "some_unknown_tool"];
    const result = routeTools(toolsWithGeneral, ["sales"])!;
    expect(result).toContain("some_unknown_tool");
  });

  it("produces fewer tools for a single-app turn than the full set", () => {
    const full = routeTools(allTools, ["sales", "growth", "operations", "accounting"])!;
    const single = routeTools(allTools, ["sales"])!;
    expect(single.length).toBeLessThan(full.length);
  });
});
