import { describe, expect, it } from "vitest";
import { INDUSTRIES, type Industry } from "./industries";
import {
  hasModule,
  industryProfile,
  labelFor,
  moduleForApiPath,
  moduleForPagePath,
  hasCapability,
  INDUSTRY_PROFILES,
  MODULE_KEYS,
  PAGE_MODULE_PREFIXES,
  CAPABILITY_KEYS,
  type LabelKey,
  type ModuleKey,
} from "./industry-profile";

const LABEL_KEYS: LabelKey[] = [
  "saleDocument",
  "saleDocumentPlural",
  "sellScreen",
  "catalogue",
  "catalogueItem",
];

const RETAIL_INDUSTRIES: Industry[] = [
  "jewelry",
  "watch",
  "accessories",
  "cosmetics",
  "wholesale",
  "tools_fittings",
  "haberdashery",
];

describe("INDUSTRY_PROFILES", () => {
  it("covers every industry the app can create", () => {
    for (const industry of INDUSTRIES) {
      expect(INDUSTRY_PROFILES[industry], industry).toBeDefined();
    }
  });

  it("names only modules that exist", () => {
    for (const industry of INDUSTRIES) {
      for (const module of industryProfile(industry).modules) {
        expect(MODULE_KEYS, `${industry}/${module}`).toContain(module);
      }
    }
  });

  it("lists no module twice", () => {
    for (const industry of INDUSTRIES) {
      const modules = industryProfile(industry).modules;
      expect(new Set(modules).size, industry).toBe(modules.length);
    }
  });

  it("gives every industry a brand of its own, never the café's", () => {
    for (const industry of RETAIL_INDUSTRIES) {
      expect(industryProfile(industry).brandTitle, industry).not.toBe("کافه و رستوران");
    }
  });
});

describe("module sets", () => {
  it("gives food_service everything the app has today", () => {
    // The regression that matters most: Wave 2 must not remove anything from
    // the café, which is the only industry that was ever complete.
    const modules = industryProfile("food_service").modules;
    for (const module of MODULE_KEYS) {
      // Retail-only: the four industry pages, and `stock` (F&B's equivalent is `inventory`).
      if (
        module === "jewelry" ||
        module === "watch" ||
        module === "accessories" ||
        module === "cosmetics" ||
        module === "wholesale" ||
        module === "tools_fittings" ||
        module === "haberdashery" ||
        module === "stock"
      )
        continue;
      // Phase 35 module keys that exist but are not yet wired into any industry:
      // `workspace` is the ecosystem shell (feature-flag gated), and `website`/
      // `messaging` get their pages in phases 37–38. `crm` left this list in
      // Phase 36, which built the app.
      if (module === "workspace" || module === "website" || module === "messaging") continue;
      expect(modules, module).toContain(module);
    }
  });

  it("gives no retail industry the F&B-only modules", () => {
    for (const industry of RETAIL_INDUSTRIES) {
      for (const module of ["tables", "waiter", "kitchen", "reservations", "delivery", "inventory", "menu"] as ModuleKey[]) {
        expect(hasModule(industry, module), `${industry}/${module}`).toBe(false);
      }
    }
  });

  it("gives each retail industry exactly its own industry page", () => {
    for (const industry of RETAIL_INDUSTRIES) {
      expect(hasModule(industry, industry as ModuleKey), industry).toBe(true);
      for (const other of RETAIL_INDUSTRIES) {
        if (other === industry) continue;
        expect(hasModule(industry, other as ModuleKey), `${industry} sees ${other}`).toBe(false);
      }
    }
    // F&B has none of the retail industry pages.
    for (const other of RETAIL_INDUSTRIES) {
      expect(hasModule("food_service", other as ModuleKey), `food_service sees ${other}`).toBe(false);
    }
  });

  it("gives every industry the core platform", () => {
    for (const industry of INDUSTRIES) {
      for (const module of ["dashboard", "customers", "ledger", "reports", "settings"] as ModuleKey[]) {
        expect(hasModule(industry, module), `${industry}/${module}`).toBe(true);
      }
    }
  });

  it("gives every industry a selling screen", () => {
    for (const industry of INDUSTRIES) {
      expect(hasModule(industry, "pos"), industry).toBe(true);
    }
  });

  it("keeps the open-orders board to F&B", () => {
    // /dashboard/orders is a board of open tickets with kitchen statuses and a
    // realtime feed. A retail invoice is settled the moment it is written, so
    // it would never appear there; the shop's history lives on its selling
    // screen instead.
    expect(hasModule("food_service", "orders")).toBe(true);
    for (const industry of RETAIL_INDUSTRIES) {
      expect(hasModule(industry, "orders"), industry).toBe(false);
    }
  });
});

describe("labelFor", () => {
  it("resolves every label for every industry", () => {
    for (const industry of INDUSTRIES) {
      for (const key of LABEL_KEYS) {
        expect(labelFor(industry, key), `${industry}/${key}`).toBeTruthy();
      }
    }
  });

  it("falls back to the F&B word when an industry has no opinion", () => {
    // food_service overrides nothing, so it is the fallback by construction.
    expect(industryProfile("food_service").labels).toEqual({});
    expect(labelFor("food_service", "saleDocument")).toBe("سفارش");
    expect(labelFor("food_service", "catalogue")).toBe("منو");
  });

  it("calls a retail sale a فاکتور, not a سفارش", () => {
    for (const industry of RETAIL_INDUSTRIES) {
      expect(labelFor(industry, "saleDocument"), industry).toBe("فاکتور");
      expect(labelFor(industry, "saleDocumentPlural"), industry).toBe("فاکتورها");
    }
  });

  it("never shows a retail business menu wording", () => {
    for (const industry of RETAIL_INDUSTRIES) {
      for (const key of LABEL_KEYS) {
        expect(labelFor(industry, key), `${industry}/${key}`).not.toContain("منو");
      }
    }
  });
});

describe("capabilities", () => {
  it("names only declared capabilities", () => {
    for (const industry of INDUSTRIES) {
      for (const capability of industryProfile(industry).capabilities) {
        expect(CAPABILITY_KEYS, `${industry}/${capability}`).toContain(capability);
      }
    }
  });

  it("hasCapability reflects the profile", () => {
    for (const industry of INDUSTRIES) {
      for (const capability of CAPABILITY_KEYS) {
        expect(hasCapability(industry, capability), `${industry}/${capability}`).toBe(
          industryProfile(industry).capabilities.includes(capability),
        );
      }
    }
  });
});

describe("salesModel", () => {
  it("keeps F&B on order tickets and puts retail on invoices", () => {
    expect(industryProfile("food_service").salesModel).toBe("order_ticket");
    for (const industry of RETAIL_INDUSTRIES) {
      expect(industryProfile(industry).salesModel, industry).toBe("retail_invoice");
    }
  });
});

describe("defaultDisabledFeatures", () => {
  it("turns nothing off for food_service", () => {
    expect(industryProfile("food_service").defaultDisabledFeatures).toEqual([]);
  });

  it("turns off the F&B-shaped features for retail", () => {
    for (const industry of RETAIL_INDUSTRIES) {
      expect(industryProfile(industry).defaultDisabledFeatures, industry).toContain("inventory");
      expect(industryProfile(industry).defaultDisabledFeatures, industry).toContain("reservations");
    }
  });
});

describe("Phase 35 module keys", () => {
  it("declares the ecosystem and future-phase keys without assigning them to any industry yet", () => {
    // These keys exist so the app registry (src/lib/apps.ts) can give them a
    // place, but neither is wired into a trade yet: `workspace` is the
    // ecosystem shell (feature-flag gated) and `website`/`messaging` get their
    // pages in phases 37–38. Locking this prevents a profile from silently
    // gaining one and changing module-gated routing.
    const futureKeys = ["workspace", "website", "messaging"] as const;
    for (const key of futureKeys) {
      expect(MODULE_KEYS, key).toContain(key);
      for (const industry of INDUSTRIES) {
        expect(hasModule(industry, key as ModuleKey), `${industry} should not yet have ${key}`).toBe(false);
      }
    }
  });

  it("gives every trade the CRM, now that Phase 36 has built it", () => {
    // The CRM is core, like `customers`: it is built on records every profile
    // already has, and a jeweller keeps a customer file exactly as a café does.
    // A trade that lost this key would 403 on every /api/crm route.
    for (const industry of INDUSTRIES) {
      expect(hasModule(industry, "crm"), `${industry} should have crm`).toBe(true);
    }
  });
});

describe("moduleForApiPath", () => {
  it("maps a route and everything under it", () => {
    expect(moduleForApiPath("/api/tables")).toBe("tables");
    expect(moduleForApiPath("/api/tables/abc/close")).toBe("tables");
    expect(moduleForApiPath("/api/menu/items")).toBe("menu");
    expect(moduleForApiPath("/api/inventory/counts")).toBe("inventory");
  });

  it("does not match a prefix that is only a string prefix", () => {
    // "/api/ordersomething" is not under "/api/orders".
    expect(moduleForApiPath("/api/ordersomething")).toBeNull();
  });

  it("leaves cross-industry routes ungated", () => {
    for (const path of [
      "/api/auth/login",
      "/api/customers",
      "/api/ledger/entries",
      "/api/reports/sales",
      "/api/settings/business",
      "/api/locations/active",
    ]) {
      expect(moduleForApiPath(path), path).toBeNull();
    }
  });

  it("leaves the industry routes to their own stricter guard", () => {
    // requireIndustryForApi already checks these against the exact industry,
    // which is stronger than a module lookup; double-gating would be noise.
    for (const path of ["/api/jewelry/items", "/api/watch/units", "/api/accessories/items"]) {
      expect(moduleForApiPath(path), path).toBeNull();
    }
  });
});

describe("moduleForPagePath", () => {
  it("maps a page and its children", () => {
    expect(moduleForPagePath("/dashboard/floor")).toBe("tables");
    expect(moduleForPagePath("/dashboard/orders/abc")).toBe("orders");
  });

  it("leaves the dashboard root and settings ungated", () => {
    expect(moduleForPagePath("/dashboard")).toBeNull();
    expect(moduleForPagePath("/dashboard/settings")).toBeNull();
  });

  it("names only modules that exist", () => {
    for (const [, module] of PAGE_MODULE_PREFIXES) {
      expect(MODULE_KEYS).toContain(module);
    }
  });
});
