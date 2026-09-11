/**
 * The inventory workspace's section list and its دائمی/ادواری visibility
 * rule, extracted framework-free (no React, no icons — the manager keeps its
 * own icon map, the way `accounting-nav.ts` documents) so the menu logic is
 * unit-testable: which sections a perpetual business sees, which a periodic
 * one does, and that the two sets differ by exactly the perpetual-only
 * instruments plus بستن دوره.
 */

export const INVENTORY_TABS = [
  { key: "warehouses", label: "لیست انبارها" },
  { key: "stock", label: "موجودی انبار" },
  { key: "counts", label: "انبارگردانی" },
  { key: "periodic-closings", label: "بستن دوره (ادواری)" },
  { key: "documents-new", label: "ثبت رسید انبار/حواله" },
  { key: "documents", label: "رسید و حواله‌های انبار" },
  { key: "items", label: "اقلام انبار" },
  { key: "production", label: "تولید" },
  { key: "recipes", label: "دستورالعمل مصرف" },
  { key: "suppliers", label: "تأمین‌کنندگان" },
  { key: "purchases", label: "خرید" },
  { key: "waste", label: "ضایعات" },
  { key: "transfers", label: "انتقال بین انبارها" },
  { key: "barcodes", label: "بارکد و لیبل" },
] as const;

export type InventoryTabKey = (typeof INVENTORY_TABS)[number]["key"];

// سیستم ادواری keeps no per-movement cost, so every perpetual instrument —
// priced counts, رسید/حواله documents, waste, transfers, production — is
// hidden for a periodic business; بستن دوره is its replacement. The
// perpetual business never sees the periodic tab, symmetrically. These keys
// mirror the service-level `periodic_system_unsupported` guards: hiding a
// tab here without a guard behind it (or vice versa) is a hole.
export const PERPETUAL_ONLY_TABS: readonly InventoryTabKey[] = [
  "counts",
  "documents-new",
  "documents",
  "production",
  "waste",
  "transfers",
];

export function visibleInventoryTabs(system: "perpetual" | "periodic" | null) {
  if (system === "periodic") return INVENTORY_TABS.filter((t) => !PERPETUAL_ONLY_TABS.includes(t.key));
  return INVENTORY_TABS.filter((t) => t.key !== "periodic-closings");
}

/** Headings over the entries; SectionNav drops keys the visible set omits. */
export const INVENTORY_TAB_GROUPS = [
  { label: "انبارها", keys: ["warehouses", "stock", "counts", "periodic-closings"] as const },
  { label: "سند انبار", keys: ["documents-new", "documents"] as const },
  {
    label: "اقلام و عملیات",
    keys: ["items", "production", "recipes", "suppliers", "purchases", "waste", "transfers", "barcodes"] as const,
  },
];
