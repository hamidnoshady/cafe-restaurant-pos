/**
 * سیستم ادواری × the inventory workspace menu: which sections each system
 * sees. The rule under test is the symmetric hide — a periodic business
 * loses every perpetual-only instrument and gains بستن دوره; a perpetual
 * business (including a legacy `null` system, the pre-periodic default)
 * sees everything except بستن دوره.
 */
import { describe, expect, it } from "vitest";
import {
  INVENTORY_TABS,
  INVENTORY_TAB_GROUPS,
  PERPETUAL_ONLY_TABS,
  visibleInventoryTabs,
} from "./inventory-nav";

const ALL_KEYS = INVENTORY_TABS.map((tab) => tab.key);

describe("INVENTORY_TABS", () => {
  it("lists every section exactly once with a non-empty label", () => {
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
    for (const tab of INVENTORY_TABS) {
      expect(tab.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("knows every perpetual-only key (the list can't name a tab that doesn't exist)", () => {
    for (const key of PERPETUAL_ONLY_TABS) {
      expect(ALL_KEYS).toContain(key);
    }
    // …and بستن دوره is never in it: it is the periodic replacement, not a
    // perpetual instrument.
    expect(PERPETUAL_ONLY_TABS).not.toContain("periodic-closings");
  });
});

describe("visibleInventoryTabs", () => {
  it("perpetual: every tab except بستن دوره", () => {
    const keys = visibleInventoryTabs("perpetual").map((tab) => tab.key);
    expect(keys).toEqual(ALL_KEYS.filter((key) => key !== "periodic-closings"));
  });

  it("null (a costing setting from before the periodic system) behaves as perpetual", () => {
    expect(visibleInventoryTabs(null)).toEqual(visibleInventoryTabs("perpetual"));
  });

  it("periodic: hides exactly the perpetual-only instruments and shows بستن دوره", () => {
    const keys = visibleInventoryTabs("periodic").map((tab) => tab.key);
    expect(keys).toContain("periodic-closings");
    for (const key of PERPETUAL_ONLY_TABS) {
      expect(keys).not.toContain(key);
    }
    // Everything else stays — items, purchases, suppliers, barcodes and the
    // un-priced views survive the switch.
    expect(keys).toEqual(ALL_KEYS.filter((key) => !PERPETUAL_ONLY_TABS.includes(key)));
  });

  it("the two systems' sets differ by exactly the perpetual-only tabs plus بستن دوره", () => {
    const perpetual = new Set(visibleInventoryTabs("perpetual").map((tab) => tab.key));
    const periodic = new Set(visibleInventoryTabs("periodic").map((tab) => tab.key));
    const onlyPerpetual = [...perpetual].filter((key) => !periodic.has(key));
    const onlyPeriodic = [...periodic].filter((key) => !perpetual.has(key));
    expect(onlyPerpetual.sort()).toEqual([...PERPETUAL_ONLY_TABS].sort());
    expect(onlyPeriodic).toEqual(["periodic-closings"]);
  });

  it("keeps the workspace's own order — a filter, never a reshuffle", () => {
    for (const system of ["perpetual", "periodic"] as const) {
      const keys = visibleInventoryTabs(system).map((tab) => tab.key);
      const expected = ALL_KEYS.filter((key) => keys.includes(key));
      expect(keys).toEqual(expected);
    }
  });
});

describe("INVENTORY_TAB_GROUPS", () => {
  it("covers every tab exactly once, so no section floats outside a heading", () => {
    const grouped = INVENTORY_TAB_GROUPS.flatMap((group) => [...group.keys]);
    expect([...grouped].sort()).toEqual([...ALL_KEYS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("keeps بستن دوره under انبارها, beside the count it replaces", () => {
    const warehouses = INVENTORY_TAB_GROUPS.find((group) => group.label === "انبارها")!;
    expect(warehouses.keys).toContain("periodic-closings");
    expect(warehouses.keys).toContain("counts");
  });
});
