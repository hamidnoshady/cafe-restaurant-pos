"use client";

import { useCallback, useEffect, useState } from "react";
import { formatQuantity } from "@/lib/digits";
import { api, ErrorBox } from "../ui";
import { useRealtime } from "../use-realtime";
import { ItemsSection } from "./items-section";
import { ProductionSection } from "./production-section";
import { RecipesSection } from "./recipes-section";
import { SuppliersSection } from "./suppliers-section";
import { PurchasesSection } from "./purchases-section";
import { WasteSection } from "./waste-section";
import { StockCountsSection } from "./stock-counts-section";
import { BarcodesSection } from "./barcodes-section";
import styles from "./inventory-workspace.module.css";

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
  /** Made in-house through a production formula rather than bought (Phase 29). */
  is_produced: boolean;
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
  { key: "production", label: "تولید" },
  { key: "recipes", label: "دستورالعمل مصرف" },
  { key: "suppliers", label: "تأمین‌کنندگان" },
  { key: "purchases", label: "خرید" },
  { key: "waste", label: "ضایعات" },
  { key: "counts", label: "شمارش انبار" },
  { key: "barcodes", label: "بارکد و لیبل" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function InventoryManager() {
  const [data, setData] = useState<InventoryData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabKey>("items");
  const [lowStock, setLowStock] = useState<LowStockItem[]>([]);

  // An error from one tab shouldn't keep showing once the user has moved on
  // to look at something else.
  useEffect(() => setError(""), [tab]);

  const load = useCallback(() => {
    api<InventoryData>("/api/inventory").then(({ ok, data }) => {
      if (ok) setData(data);
    });
  }, []);
  useEffect(load, [load]);

  const loadLowStock = useCallback(() => {
    api<{ items: LowStockItem[] }>("/api/inventory/low-stock").then(
      ({ ok, data }) => {
        if (ok) setLowStock(data.items);
      },
    );
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

  async function run(
    fn: () => Promise<{ ok: boolean; data: { error?: string } }>,
  ) {
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

  if (!data)
    return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <div className={`${styles.workspace} min-w-0 space-y-4 sm:space-y-5`}>
      <ErrorBox>{error}</ErrorBox>

      {lowStock.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p className="mb-1 font-semibold">هشدار کمبود موجودی</p>
          <ul className="list-inside list-disc space-y-0.5 leading-6">
            {lowStock.map((it) => (
              <li key={it.id}>
                {it.name}: {formatQuantity(it.stock)} {it.unit} باقی مانده
                (آستانه سفارش: {formatQuantity(it.reorderLevel ?? 0)} {it.unit})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <nav
        aria-label="بخش‌های انبار"
        className="rounded-2xl border border-stone-200/80 bg-white p-2 shadow-[0_1px_2px_rgb(41_37_36/0.03)]"
      >
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {TABS.map((t) => {
            const isActive = tab === t.key;
            return (
              <button
                key={t.key}
                id={`inventory-tab-${t.key}`}
                type="button"
                aria-pressed={isActive}
                aria-controls="inventory-tabpanel"
                onClick={() => setTab(t.key)}
                className={`min-h-[52px] rounded-xl border px-3 text-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-amber-400/40 sm:px-4 ${
                  isActive
                    ? "border-amber-200 bg-amber-100 text-amber-950 shadow-[0_1px_2px_rgb(120_53_15/0.08)]"
                    : "border-transparent bg-transparent text-stone-600 hover:border-stone-200 hover:bg-stone-50 hover:text-stone-950"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      <div
        id="inventory-tabpanel"
        role="region"
        aria-labelledby={`inventory-tab-${tab}`}
        className="min-w-0"
      >
        {tab === "items" ? (
          <ItemsSection items={data.items} busy={busy} run={run} />
        ) : null}
        {tab === "production" ? (
          <ProductionSection items={data.items} busy={busy} run={run} />
        ) : null}
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
        {tab === "suppliers" ? (
          <SuppliersSection suppliers={data.suppliers} busy={busy} run={run} />
        ) : null}
        {tab === "purchases" ? (
          <PurchasesSection
            items={data.items}
            suppliers={data.suppliers}
            busy={busy}
            run={run}
          />
        ) : null}
        {tab === "waste" ? (
          <WasteSection items={data.items} busy={busy} run={run} />
        ) : null}
        {tab === "counts" ? (
          <StockCountsSection items={data.items} busy={busy} run={run} />
        ) : null}
        {tab === "barcodes" ? (
          <BarcodesSection items={data.items} busy={busy} run={run} />
        ) : null}
      </div>
    </div>
  );
}

export type Runner = (
  fn: () => Promise<{ ok: boolean; data: { error?: string } }>,
) => Promise<boolean>;

function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    missing_fields: "فیلدهای الزامی را پر کنید.",
    invalid_reorder_level: "آستانه سفارش مجدد معتبر نیست.",
    invalid_purchase_unit_factor:
      "ضریب تبدیل واحد خرید باید بزرگ‌تر از صفر باشد.",
    not_found: "پیدا نشد.",
    item_not_found: "قلم انبار پیدا نشد.",
    supplier_not_found: "تأمین‌کننده پیدا نشد.",
    supplier_required: "برای دریافت نسیه، انتخاب تأمین‌کننده الزامی است.",
    no_items: "حداقل یک قلم لازم است.",
    invalid_item: "یکی از اقلام معتبر نیست.",
    invalid_waste_reason: "دلیل ضایعات را انتخاب کنید.",
    invalid_purchase_date: "تاریخ خرید معتبر نیست.",
    invalid_transition: "این تغییر وضعیت خرید مجاز نیست.",
    purchase_received_cannot_delete:
      "خرید دریافت‌شده برای حفظ موجودی و اسناد حسابداری قابل حذف نیست.",
    purchase_received_cannot_edit:
      "خرید دریافت‌شده قابل ویرایش نیست؛ برای اصلاح از «برگشت به تأمین‌کننده» استفاده کنید.",
    invalid_supplier_return: "اطلاعات برگشت به تأمین‌کننده کامل نیست.",
    received_purchase_not_found: "خرید دریافت‌شده پیدا نشد.",
    supplier_return_purchase_item_not_found: "قلم انتخاب‌شده متعلق به این خرید نیست.",
    supplier_return_lot_required: "برای این قلم، لایهٔ موجودی معتبر پیدا نشد.",
    supplier_return_lot_not_found: "موجودی قابل برگشت برای این قلم پیدا نشد.",
    quantity_underflow: "مقدار برگشت از موجودی باقی‌مانده بیشتر است.",
    purchase_cancelled_cannot_edit: "خرید لغوشده قابل ویرایش نیست.",
    // Phase 29 — production
    output_item_not_found: "قلم انبارِ محصول پیدا نشد.",
    formula_name_taken: "فرمولی با این نام قبلاً ثبت شده است.",
    formula_not_found: "فرمول تولید پیدا نشد.",
    formula_inactive: "این فرمول غیرفعال است و امکان ثبت تولید با آن نیست.",
    formula_has_no_inputs: "برای این فرمول هنوز ماده‌ای ثبت نشده است.",
    formula_cycle:
      "این ماده خودش (به‌طور مستقیم یا غیرمستقیم) از همین محصول ساخته می‌شود و حلقه ایجاد می‌کند.",
    invalid_yield: "مقدار تولید معتبر نیست.",
    invalid_batches: "تعداد بار پخت معتبر نیست.",
    invalid_conversion_cost: "هزینهٔ تبدیل معتبر نیست.",
    run_not_found: "سند تولید پیدا نشد.",
    run_not_reversible: "این سند تولید قابل برگشت نیست.",
    already_reversed: "این سند تولید قبلاً برگشت خورده است.",
    production_output_consumed:
      "بخشی از محصول این تولید فروخته یا مصرف شده است؛ برای اصلاح از ضایعات یا شمارش انبار استفاده کنید.",
    consumption_layer_settled:
      "کسری یکی از مواد این تولید با خرید بعدی تسویه شده است و برگشت آن ممکن نیست.",
    production_reversal_inconsistent: "برگشت این تولید با ارقام ثبت‌شده هم‌خوان نیست.",
    no_location: "شعبه‌ای ثبت نشده است.",
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی مجاز نیست.",
    bad_request: "درخواست نامعتبر بود.",
    ledger_account_missing:
      "یکی از حساب‌های مورد نیاز سیستم در سرفصل حساب‌ها یافت نشد. سرفصل حساب‌ها را بررسی کنید.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}
