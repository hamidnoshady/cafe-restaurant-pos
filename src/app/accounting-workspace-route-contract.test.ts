/**
 * The operational-route move has a stronger contract than an ordinary link:
 * every canonical address must have an App Router page and every retired
 * Dashboard address must be redirect-only. Keeping both assertions in one
 * explicit table prevents a future page move from producing a 404 at the new
 * URL or silently restoring a duplicate page at the old URL.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_WORKSPACE_HREFS,
  accountingProductsHref,
  canonicalPathForLegacy,
  legacyRedirectTarget,
} from "@/lib/app-routes";

const APP_DIR = fileURLToPath(new URL("./", import.meta.url));
const ACCOUNTING_DIR = join(APP_DIR, "(app)", "accounting");
const DASHBOARD_DIR = join(APP_DIR, "dashboard");

const OPERATIONAL_ROUTES: readonly (readonly [
  legacy: string,
  canonical: string,
  canonicalPage: string,
  legacyPage: string,
])[] = [
  [
    "/dashboard/pos",
    ACCOUNTING_WORKSPACE_HREFS.pos,
    "pos/page.tsx",
    "pos/page.tsx",
  ],
  [
    "/dashboard/stock",
    ACCOUNTING_WORKSPACE_HREFS.inventory,
    "inventory/page.tsx",
    "stock/page.tsx",
  ],
  [
    "/dashboard/inventory",
    ACCOUNTING_WORKSPACE_HREFS.inventory,
    "inventory/page.tsx",
    "inventory/page.tsx",
  ],
  [
    "/dashboard/products",
    ACCOUNTING_WORKSPACE_HREFS.products,
    "products/page.tsx",
    "products/page.tsx",
  ],
  [
    "/dashboard/products/new",
    accountingProductsHref("new"),
    "products/new/page.tsx",
    "products/new/page.tsx",
  ],
  [
    "/dashboard/products/prices",
    accountingProductsHref("prices"),
    "products/prices/page.tsx",
    "products/prices/page.tsx",
  ],
  [
    "/dashboard/products/attributes",
    accountingProductsHref("attributes"),
    "products/attributes/page.tsx",
    "products/attributes/page.tsx",
  ],
  [
    "/dashboard/products/barcode-templates",
    accountingProductsHref("barcode-templates"),
    "products/barcode-templates/page.tsx",
    "products/barcode-templates/page.tsx",
  ],
  [
    "/dashboard/products/reports",
    accountingProductsHref("reports"),
    "products/reports/page.tsx",
    "products/reports/page.tsx",
  ],
  [
    "/dashboard/cosmetics",
    ACCOUNTING_WORKSPACE_HREFS.cosmetics,
    "cosmetics/page.tsx",
    "cosmetics/page.tsx",
  ],
  [
    "/dashboard/reports",
    ACCOUNTING_WORKSPACE_HREFS.reports,
    "reports/page.tsx",
    "reports/page.tsx",
  ],
  [
    "/dashboard/floor",
    ACCOUNTING_WORKSPACE_HREFS.floor,
    "floor/page.tsx",
    "floor/page.tsx",
  ],
  [
    "/dashboard/kitchen",
    ACCOUNTING_WORKSPACE_HREFS.kitchen,
    "kitchen/page.tsx",
    "kitchen/page.tsx",
  ],
  [
    "/dashboard/reservations",
    ACCOUNTING_WORKSPACE_HREFS.reservations,
    "reservations/page.tsx",
    "reservations/page.tsx",
  ],
  [
    "/dashboard/delivery",
    ACCOUNTING_WORKSPACE_HREFS.delivery,
    "delivery/page.tsx",
    "delivery/page.tsx",
  ],
];

describe("Accounting operational route contract", () => {
  it("ships a page module for every canonical address, so none can 404", () => {
    for (const [, canonical, canonicalPage] of OPERATIONAL_ROUTES) {
      expect(
        existsSync(join(ACCOUNTING_DIR, canonicalPage)),
        `${canonical} needs ${canonicalPage}`,
      ).toBe(true);
    }
  });

  it("removes every old Dashboard page module", () => {
    for (const [legacy, , , legacyPage] of OPERATIONAL_ROUTES) {
      expect(
        existsSync(join(DASHBOARD_DIR, legacyPage)),
        `${legacy} must be redirect-only`,
      ).toBe(false);
    }
  });

  it("permanently redirects every old address and preserves nested product paths", () => {
    for (const [legacy, canonical] of OPERATIONAL_ROUTES) {
      expect(canonicalPathForLegacy(legacy), legacy).toBe(canonical);
      expect(legacyRedirectTarget(legacy, "?source=bookmark"), legacy).toBe(
        `${canonical}?source=bookmark`,
      );
    }
  });
});
