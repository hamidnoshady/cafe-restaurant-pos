"use client";

import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { api, ErrorBox } from "../ui";
import { useRealtime } from "../use-realtime";
import { ItemsSection } from "./items-section";
import { RecipesSection } from "./recipes-section";
import { SuppliersSection } from "./suppliers-section";
import { PurchasesSection } from "./purchases-section";
import { WasteSection } from "./waste-section";
import { StockCountsSection } from "./stock-counts-section";

export interface InventoryItem {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  reorder_level: string | number | null;
  avg_cost: string | number;
  purchase_unit: string | null;
  purchase_unit_factor: string | number;
  is_active: boolean;
  stock: number;
}
export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  is_active: boolean;
}
export interface MenuItemRef {
  id: string;
  name: string;
}
export interface ModifierRef {
  id: string;
  name: string;
  group_id: string;
  group_name: string;
}
export interface RecipeLink {
  menu_item_id: string;
  inventory_item_id: string;
  quantity: string | number;
}
export interface ModifierRecipeLink {
  modifier_id: string;
  inventory_item_id: string;
  quantity_delta: string | number;
}

interface InventoryData {
  items: InventoryItem[];
  suppliers: Supplier[];
  menuItems: MenuItemRef[];
  modifiers: ModifierRef[];
  recipes: RecipeLink[];
  modifierRecipes: ModifierRecipeLink[];
  costingMethod: "fifo" | "weighted_average" | null;
}

interface LowStockItem {
  id: string;
  name: string;
  unit: string;
  reorderLevel: number | null;
  stock: number;
}

const TABS = [
  { key: "items", label: "اقلام انبار" },
  { key: "recipes", label: "دستورالعمل مصرف" },
  { key: "suppliers", label: "تأمین‌کنندگان" },
  { key: "purchases", label: "خرید" },
  { key: "waste", label: "ضایعات" },
  { key: "counts", label: "شمارش انبار" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function InventoryManager() {
  const [data, setData] = useState<InventoryData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabKey>("items");
  const [lowStock, setLowStock] = useState<LowStockItem[]>([]);

  const load = useCallback(() => {
    api<InventoryData>("/api/inventory").then(({ ok, data }) => {
      if (ok) setData(data);
    });
  }, []);
  useEffect(load, [load]);

  const loadLowStock = useCallback(() => {
    api<{ items: LowStockItem[] }>("/api/inventory/low-stock").then(({ ok, data }) => {
      if (ok) setLowStock(data.items);
    });
  }, []);
  useEffect(loadLowStock, [loadLowStock]);

  useRealtime(
    useCallback(
      (event) => {
        if (event.type === "inventory.low_stock") loadLowStock();
      },
      [loadLowStock],
    ),
  );

  async function run(fn: () => Promise<{ ok: boolean; data: { error?: string } }>) {
    setBusy(true);
    setError("");
    const { ok, data } = await fn();
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return false;
    }
    load();
    loadLowStock();
    return true;
  }

  if (!data) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <div className="space-y-6">
      <ErrorBox>{error}</ErrorBox>
      {lowStock.length > 0 ? (
        <div className="rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 text-sm text-primary">
          <p className="mb-1 font-semibold">هشدار کمبود موجودی</p>
          <ul className="list-inside list-disc space-y-0.5">
            {lowStock.map((it) => (
              <li key={it.id}>
                {it.name}: {toPersianDigits(it.stock)} {it.unit} باقی مانده (آستانه سفارش:{" "}
                {toPersianDigits(it.reorderLevel ?? 0)} {it.unit})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-b border-border pb-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              tab === t.key ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "items" ? <ItemsSection items={data.items} busy={busy} run={run} /> : null}
      {tab === "recipes" ? (
        <RecipesSection
          items={data.items}
          menuItems={data.menuItems}
          modifiers={data.modifiers}
          recipes={data.recipes}
          modifierRecipes={data.modifierRecipes}
          busy={busy}
          run={run}
        />
      ) : null}
      {tab === "suppliers" ? <SuppliersSection suppliers={data.suppliers} busy={busy} run={run} /> : null}
      {tab === "purchases" ? (
        <PurchasesSection items={data.items} suppliers={data.suppliers} busy={busy} run={run} />
      ) : null}
      {tab === "waste" ? <WasteSection items={data.items} busy={busy} run={run} /> : null}
      {tab === "counts" ? <StockCountsSection items={data.items} busy={busy} run={run} /> : null}
    </div>
  );
}

export type Runner = (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean>;

function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    missing_fields: "فیلدهای الزامی را پر کنید.",
    invalid_reorder_level: "آستانه سفارش مجدد معتبر نیست.",
    invalid_purchase_unit_factor: "ضریب تبدیل واحد خرید باید بزرگ‌تر از صفر باشد.",
    not_found: "پیدا نشد.",
    item_not_found: "قلم انبار پیدا نشد.",
    supplier_not_found: "تأمین‌کننده پیدا نشد.",
    no_items: "حداقل یک قلم لازم است.",
    invalid_item: "یکی از اقلام معتبر نیست.",
    invalid_waste_reason: "دلیل ضایعات را انتخاب کنید.",
    invalid_transition: "این تغییر وضعیت خرید مجاز نیست.",
    no_location: "شعبه‌ای ثبت نشده است.",
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی مجاز نیست.",
    bad_request: "درخواست نامعتبر بود.",
    ledger_account_missing: "یکی از حساب‌های مورد نیاز سیستم در سرفصل حساب‌ها یافت نشد. سرفصل حساب‌ها را بررسی کنید.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}
