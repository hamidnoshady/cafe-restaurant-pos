"use client";

/**
 * Phase 42b — «موجودی انبار»: the per-warehouse stock level on the RETAIL
 * model. One row per active sellable item of the selected warehouse:
 * quantity and running cost from `item_stock` (for a batch-tracked item, the
 * 0078 rollup of its batches), value = quantity × cost, and a low/out badge
 * from the item's reorder point. Search and the status chips filter
 * client-side over the warehouse's items; the footer totals (units and
 * value) come from the server.
 */
import { useEffect, useMemo, useState } from "react";
import { SearchIcon } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { api, inputClass } from "../ui";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "../page-chrome";
import { type Warehouse } from "./warehouses-section";

interface StockItem {
  id: string;
  name: string;
  sku: string | null;
  tracking: string;
  quantity: string;
  unitCost: number | null;
  reorderPoint: string;
  valueRial: number;
  level: "out" | "low" | "ok";
}

interface StockTotals {
  count: number;
  lowStockCount: number;
  totalUnits: string;
  totalValueRial: string;
}

interface StockLevelsResponse {
  locationId: string;
  items: StockItem[];
  totals: StockTotals;
}

type StatusFilter = "all" | "low" | "out";

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "همه" },
  { key: "low", label: "کم‌موجودی" },
  { key: "out", label: "ناموجود" },
];

const chipClass = (active: boolean) =>
  `min-h-[44px] rounded-xl border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-amber-400/40 ${
    active
      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
      : "border-border bg-card text-stone-700 dark:text-stone-300 hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-stone-950 dark:hover:text-stone-100"
  }`;

const STATUS_META: Record<"out" | "low" | "ok", { label: string; tone: "danger" | "active" | "neutral" }> = {
  out: { label: "ناموجود", tone: "danger" },
  low: { label: "کم‌موجودی", tone: "active" },
  ok: { label: "کافی", tone: "neutral" },
};

const TRACKING_LABELS: Record<string, string> = {
  none: "عادی",
  batch: "بچ‌محور",
  serial: "سریالی",
  weight: "وزنی",
};

export function StockLevelsSection({ locationId: controlledLocationId }: { locationId?: string | null }) {
  const money = useMoney();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [locationId, setLocationId] = useState(controlledLocationId ?? "");
  const [data, setData] = useState<StockLevelsResponse | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  useEffect(() => {
    api<{ warehouses: Warehouse[] }>("/api/stock/warehouses").then(({ ok, data }) => {
      if (ok) setWarehouses(data.warehouses);
    });
  }, []);

  useEffect(() => {
    if (controlledLocationId) setLocationId(controlledLocationId);
  }, [controlledLocationId]);

  // Default to the first active warehouse once the list lands.
  useEffect(() => {
    if (!locationId && warehouses.length > 0) {
      setLocationId(warehouses.find((w) => w.is_active)?.id ?? warehouses[0].id);
    }
  }, [warehouses, locationId]);

  useEffect(() => {
    if (!locationId) return;
    let cancelled = false;
    setData(null);
    api<StockLevelsResponse>(`/api/stock/stock-levels?locationId=${encodeURIComponent(locationId)}`).then(
      ({ ok, data }) => {
        if (!cancelled) setData(ok ? data : null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  const visibleItems = useMemo(() => {
    if (!data) return [];
    const term = search.trim();
    return data.items.filter((item) => {
      if (statusFilter !== "all" && item.level !== statusFilter) return false;
      if (!term) return true;
      return item.name.includes(term) || (item.sku ?? "").includes(term);
    });
  }, [data, search, statusFilter]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">انبارها</p>
            <h2 className="mt-1 font-semibold text-foreground">موجودی انبار</h2>
          </div>
        }
        description="موجودی هر کالا در انبار انتخاب‌شده؛ برای کالای بچ‌محور، جمع موجودی بچ‌های آن است."
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-64">
            <SearchableSelect
              value={locationId}
              onChange={setLocationId}
              options={[
                { value: "", label: "انبار را انتخاب کنید…" },
                ...warehouses.map((w) => ({ value: w.id, label: w.name })),
              ]}
            />
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="وضعیت موجودی">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={chipClass(statusFilter === f.key)}
                aria-pressed={statusFilter === f.key}
                onClick={() => setStatusFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="relative w-full sm:w-64">
            <SearchIcon aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground" />
            <input
              className={`${inputClass} ps-9`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="جستجوی نام یا کد کالا"
              aria-label="جستجوی کالا"
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard flush>
        {data === null ? (
          <div className="p-4 sm:p-5">
            <LoadingSkeleton rows={5} label="در حال بارگذاری موجودی انبار" />
          </div>
        ) : data.items.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>این انبار کالایی ندارد. از صفحهٔ مدیریت کالاهای صنف، کالا اضافه کنید.</EmptyState>
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>کالایی با این فیلترها پیدا نشد.</EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border bg-stone-50 dark:bg-stone-900/40">
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">کالا</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">ردیابی</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">موجودی</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">بهای تمام‌شده</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">ارزش</th>
                  <th className="py-3 pe-4 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:pe-5 sm:text-sm">وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-border/80 transition-colors last:border-b-0 hover:bg-stone-50/70 dark:hover:bg-stone-900/30"
                  >
                    <td className="px-4 py-3 sm:px-5">
                      <span className="font-medium text-foreground">{item.name}</span>
                      {item.sku ? <span className="ms-2 text-xs text-muted-foreground">{item.sku}</span> : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{TRACKING_LABELS[item.tracking] ?? item.tracking}</td>
                    <td className="px-4 py-3 font-medium tabular-nums">{formatQuantity(item.quantity)}</td>
                    <td className="px-4 py-3 tabular-nums">{item.unitCost == null ? "—" : money.format(item.unitCost)}</td>
                    <td className="px-4 py-3 tabular-nums">{money.format(item.valueRial)}</td>
                    <td className="py-3 pe-4 sm:pe-5">
                      <StatusBadge tone={STATUS_META[item.level].tone}>{STATUS_META[item.level].label}</StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-stone-50/60 dark:bg-stone-900/30">
                  <td className="px-4 py-3 text-xs font-semibold text-stone-600 dark:text-stone-300 sm:px-5">
                    {toPersianDigits(String(data.totals.count))} کالا
                    {data.totals.lowStockCount > 0 ? ` · ${toPersianDigits(String(data.totals.lowStockCount))} قلم کم‌موجودی/ناموجود` : ""}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground sm:px-5">جمع واحدها:</td>
                  <td className="px-4 py-3 font-semibold tabular-nums">{formatQuantity(data.totals.totalUnits)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground sm:px-5">جمع ارزش:</td>
                  <td colSpan={2} className="py-3 pe-4 font-semibold tabular-nums sm:pe-5">
                    {money.format(Number(data.totals.totalValueRial))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
