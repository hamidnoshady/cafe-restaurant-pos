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

  it("gives the customer record its own app and puts selling in Accounting", () => {
    // Phase 35 seated `crm` under Growth as a forward reference. Phase 36 built
    // it and moved it out, together with `customers`: the customer record is
    // read by every app (the POS creates it, Growth messages it, the service desk
    // argues with it), so it cannot live behind the door of the one department
    // that markets to them. One app owns the record; the rest read it.
    expect(appForModule("crm")).toBe("crm");
    expect(appForModule("customers")).toBe("crm");
    expect(appForModule("pos")).toBe("accounting");
    expect(appForModule("orders")).toBe("accounting");
  });

  it("keeps the still-unbuilt messaging key under Growth & Marketing", () => {
    // SMS/email acts *on* an audience rather than owning the customer record,
    // so it stays with the engines that will use it.
    expect(appForModule("messaging")).toBe("growth");
  });

  it("gives the website manager its own app, not a section of Growth", () => {
    // Originally seated under Growth (#378) as a forward reference; it is an
    // integration with an external system of record (eshobe-cms), not a
    // marketing engine, so it is a peer app instead.
    expect(appForModule("website")).toBe("website");
  });

  it("treats the assistant, the workspace shell and the connections hub as not-apps", () => {
    // The assistant is the chat *home*, not an app in the rail, the
    // workspace is the shell around the apps — and the «اتصال‌های فنی» hub
    // is a technical utility of the shell, never listed in the platform
    // switchboard. None of the three is a content area.
    expect(appForModule("ai")).toBeNull();
    expect(appForModule("workspace")).toBeNull();
    expect(appForModule("connections")).toBeNull();
    expect(appForModule("settings")).toBeNull();
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
      expect.arrayContaining(["loyalty", "promotions", "commission", "messaging"]),
    );
    // The engines act on customers; they do not own the record. The website
    // manager is its own app now, not one of Growth's engines.
    expect(modulesForApp("growth")).not.toContain("crm");
    expect(modulesForApp("growth")).not.toContain("customers");
    expect(modulesForApp("growth")).not.toContain("website");
  });

  it("returns the one Website app owning both website managers", () => {
    // «مدیریت وب‌سایت» is one app with two managers — the Eshobe CMS site
    // builder and the WordPress/WooCommerce manager. Splitting them back into
    // two rail entries is the regression this pins.
    const website = appForKey("website");
    expect(website.label).toBe("مدیریت وب‌سایت");
    expect(modulesForApp("website")).toEqual(["website", "integrations"]);
  });

  it("returns the CRM app owning both the customer record and the CRM surfaces", () => {
    const crm = appForKey("crm");
    expect(crm.label).toBe("ارتباط با مشتری");
    expect(modulesForApp("crm")).toEqual(expect.arrayContaining(["crm", "customers"]));
  });

  it("puts selling and operations inside Accounting", () => {
    expect(modulesForApp("accounting")).toEqual(expect.arrayContaining([
      "dashboard", "orders", "pos", "inventory", "kitchen", "ledger", "reports",
    ]));
  });
});

describe("isAppKey", () => {
  it("recognises exactly the declared keys", () => {
    expect(APP_KEYS.every((key) => isAppKey(key))).toBe(true);
    expect(isAppKey("loyalty")).toBe(false);
    // The connections hub is a shell utility, not a platform app: it must
    // never resolve as an app key or the switchboard would list it.
    expect(isAppKey("connections")).toBe(false);
    expect(isAppKey("sales")).toBe(false);
    expect(isAppKey("operations")).toBe(false);
    expect(isAppKey("settings")).toBe(false);
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

  it("always shows the Website app — every trade has the website module", () => {
    for (const industry of INDUSTRIES) {
      expect(visibleApps({ industry }).map((app) => app.key)).toContain("website");
    }
  });
});

describe("unassignedModules", () => {
  it("marks only the shell modules as intentionally not apps", () => {
    const unassigned = unassignedModules();
    expect(unassigned).toContain("ai");
    expect(unassigned).toContain("workspace");
    // The «اتصال‌های فنی» hub is a shell utility: its module stays
    // unassigned so the availability gate can never lock it.
    expect(unassigned).toContain("connections");
    expect(unassigned).toContain("settings");
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
    // Selling and ledger entries share the Accounting app.
    expect(grouped.map((group) => group.app.key)).toEqual(["accounting", "growth"]);
    expect(grouped[0].items.map((item) => item.label)).toEqual(["صندوق", "حسابداری"]);
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
    // Food service has both Accounting and Growth.
    const grouped = appsForNav(items, "food_service");
    expect(grouped.map((group) => group.app.key)).toEqual(["accounting", "growth"]);
  });
});
