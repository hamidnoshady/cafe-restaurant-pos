import { describe, expect, it } from "vitest";
import {
  APPS,
  APP_KEYS,
  appForModule,
  appForKey,
  appsForNav,
  isAppKey,
  modulesForApp,
  unassignedModules,
  visibleApps,
} from "./apps";
import { INDUSTRIES } from "./industries";
import { hasModule, MODULE_KEYS, type ModuleKey } from "./industry-profile";

describe("appForModule", () => {
  it("groups loyalty, promotions and commission under Growth & Marketing", () => {
    // The headline of Wave 1: three separate sidebar entries become one app.
    expect(appForModule("loyalty")).toBe("growth");
    expect(appForModule("promotions")).toBe("growth");
    expect(appForModule("commission")).toBe("growth");
  });

  it("places the future-phase keys under Growth & Marketing as forward references", () => {
    // Their pages land in phases 36–38 (CRM, website manager, SMS/email), but
    // Phase 35 builds the module key and its place in the app list now.
    expect(appForModule("crm")).toBe("growth");
    expect(appForModule("website")).toBe("growth");
    expect(appForModule("messaging")).toBe("growth");
  });

  it("treats the assistant and the workspace shell as not-apps", () => {
    // The assistant is the chat *home*, not an app in the rail, and the
    // workspace is the shell around the apps — neither is a content area.
    expect(appForModule("ai")).toBeNull();
    expect(appForModule("workspace")).toBeNull();
  });

  it("keeps every other module in exactly one app", () => {
    const assigned = MODULE_KEYS.filter((module) => appForModule(module) !== null);
    expect(assigned).not.toContain("ai");
    expect(assigned).not.toContain("workspace");
    for (const module of assigned) {
      expect(APP_KEYS, module).toContain(appForModule(module));
    }
  });
});

describe("APPS registry integrity", () => {
  it("claims no module twice", () => {
    // Importing apps.ts already runs the map builder, which throws on a
    // duplicate; this is a belt-and-braces check the same module is never in
    // two apps.
    const seen = new Set<string>();
    for (const app of APPS) {
      for (const module of app.modules) {
        expect(seen.has(module), `module "${module}" claimed by two apps`).toBe(false);
        seen.add(module);
      }
    }
  });

  it("declares every app key exactly once and resolves each to a def", () => {
    expect(APPS.map((app) => app.key).sort()).toEqual([...APP_KEYS].sort());
    for (const key of APP_KEYS) {
      expect(appForKey(key).key).toBe(key);
    }
  });
});

describe("appForKey / modulesForApp", () => {
  it("returns the Growth & Marketing def with its modules", () => {
    const growth = appForKey("growth");
    expect(growth.label).toBe("رشد و بازاریابی");
    expect(modulesForApp("growth")).toEqual(
      expect.arrayContaining(["loyalty", "promotions", "commission", "crm", "website", "messaging"]),
    );
  });

  it("returns the Sales app grouping dashboard, orders, pos and customers", () => {
    expect(modulesForApp("sales")).toEqual(
      expect.arrayContaining(["dashboard", "orders", "pos", "customers"]),
    );
  });
});

describe("isAppKey", () => {
  it("recognises exactly the declared keys", () => {
    expect(APP_KEYS.every((key) => isAppKey(key))).toBe(true);
    expect(isAppKey("loyalty")).toBe(false);
    expect(isAppKey(null)).toBe(false);
    expect(isAppKey(undefined)).toBe(false);
  });
});

describe("visibleApps", () => {
  it("returns every app when no industry is supplied", () => {
    expect(visibleApps()).toEqual(APPS);
    expect(visibleApps({})).toEqual(APPS);
  });

  it("shows an app only when the trade has at least one of its modules", () => {
    for (const industry of INDUSTRIES) {
      const apps = visibleApps({ industry });
      const expected = APPS.filter((app) => app.modules.some((module) => hasModule(industry, module)));
      expect(apps.map((app) => app.key).sort()).toEqual(expected.map((app) => app.key).sort());
    }
  });

  it("always shows Growth & Marketing — every trade has loyalty", () => {
    for (const industry of INDUSTRIES) {
      expect(visibleApps({ industry }).map((app) => app.key)).toContain("growth");
    }
  });
});

describe("unassignedModules", () => {
  it("marks only the assistant and the workspace shell as intentionally not apps", () => {
    const unassigned = unassignedModules();
    expect(unassigned).toContain("ai");
    expect(unassigned).toContain("workspace");
    expect(unassigned).not.toContain("crm");
    expect(unassigned).not.toContain("loyalty");
  });
});

describe("appsForNav", () => {
  const items = [
    { label: "وفاداری", module: "loyalty" as ModuleKey },
    { label: "کمپین‌ها", module: "promotions" as ModuleKey },
    { label: "پورسانت", module: "commission" as ModuleKey },
    { label: "صندوق", module: "pos" as ModuleKey },
    { label: "حسابداری", module: "ledger" as ModuleKey },
    // `ai` has no app (it is the chat home) and `stock` is retail-only; both
    // must be dropped, not grouped under a bogus app.
    { label: "دستیار", module: "ai" as ModuleKey },
  ];

  it("groups nav items by their owning app, in APP_KEYS order", () => {
    const grouped = appsForNav(items);
    // APP_KEYS order is sales → growth → operations → accounting → …, so the
    // groups present in `items` come back sales, growth, accounting.
    expect(grouped.map((group) => group.app.key)).toEqual(["sales", "growth", "accounting"]);
    expect(grouped[0].app.key).toBe("sales");
    expect(grouped[0].items.map((item) => item.label)).toEqual(["صندوق"]);
    expect(grouped.find((group) => group.app.key === "growth")?.items.map((item) => item.label)).toEqual([
      "وفاداری",
      "کمپین‌ها",
      "پورسانت",
    ]);
  });

  it("drops items whose module is not part of any app", () => {
    const grouped = appsForNav(items);
    const allItems = grouped.flatMap((group) => group.items);
    expect(allItems).toHaveLength(5); // the `ai` item is excluded
  });

  it("keeps only apps the trade has, given an industry", () => {
    // Every industry has loyalty (growth), pos (sales) and ledger (accounting),
    // so all three groups survive for food_service.
    const grouped = appsForNav(items, "food_service");
    expect(grouped.map((group) => group.app.key)).toEqual(["sales", "growth", "accounting"]);
  });
});
