"use client";

/**
 * Phase 42 — «موجودی انبار»: the per-warehouse stock level.
 *
 * One row per active item of the selected warehouse: quantity from the
 * append-only stock ledger, value from v_inventory_valuation (the canonical
 * figure the NRV and GL reconciliation views share), and a low/out badge
 * from the item's reorder threshold. Search and the status chips filter
 * client-side over the warehouse's items.
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
  item_name: string;
  sku: string | null;
  unit: string;
  quantity: string;
  reorder_level: string | null;
  value_rial: string;
  unit_cost: string;
}

interface StockTotals {
  count: number;
  lowStockCount: number;
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

/** Same rule as isLowStock in src/lib/inventory: threshold set and stock at/below it. */
function stockStatus(item: StockItem): "out" | "low" | "ok" {
  const qty = Number(item.quantity);
  if (qty <= 0) return "out";
  const reorder = item.reorder_level === null ? null : Number(item.reorder_level);
  if (reorder !== null && qty <= reorder) return "low";
  return "ok";
}

const STATUS_META: Record<"out" | "low" | "ok", { label: string; tone: "danger" | "active" | "neutral" }> = {
  out: { label: "ناموجود", tone: "danger" },
  low: { label: "کم‌موجودی", tone: "active" },
  ok: { label: "کافی", tone: "neutral" },
};

export function StockSection({ locationId: controlledLocationId }: { locationId?: string | null }) {
  const money = useMoney();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [locationId, setLocationId] = useState(controlledLocationId ?? "");
  const [data, setData] = useState<StockLevelsResponse | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  useEffect(() => {
    api<{ warehouses: Warehouse[] }>("/api/inventory/warehouses").then(({ ok, data }) => {
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
    api<StockLevelsResponse>(`/api/inventory/stock-levels?locationId=${encodeURIComponent(locationId)}`).then(
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
      if (statusFilter !== "all" && stockStatus(item) !== statusFilter) return false;
      if (!term) return true;
      return item.item_name.includes(term) || (item.sku ?? "").includes(term);
    });
  }, [data, search, statusFilter]);

  const selectedName = useMemo(
    () => warehouses.find((w) => w.id === locationId)?.name ?? null,
    [warehouses, locationId],
  );

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">انبارها</p>
            <h2 className="mt-1 font-semibold text-foreground">موجودی انبار</h2>
          </div>
        }
        description="مقدار و ارزش هر قلم در انبار انتخاب‌شده، بر اساس دفتر موجودی و ارزش‌گذاری رسمی انبار."
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
          <div className="relative min-w-[200px] flex-1">
            <SearchIcon aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className={`${inputClass} ps-9`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="جستجوی نام یا کد قلم…"
              aria-label="جستجو در اقلام"
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="فیلتر وضعیت">
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
      </SectionCard>

      <SectionCard
        footer={
          data ? (
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
              <span>
                {toPersianDigits(String(data.totals.count))} قلم
                {data.totals.lowStockCount > 0 ? ` · ${toPersianDigits(String(data.totals.lowStockCount))} کم‌موجودی` : ""}
              </span>
              <span className="font-semibold">
                ارزش کل موجودی: {money.format(Number(data.totals.totalValueRial))}
              </span>
            </div>
          ) : undefined
        }
        flush
      >
        {!locationId ? (
          <div className="p-4 sm:p-5">
            <EmptyState>برای مشاهده موجودی، یک انبار انتخاب کنید.</EmptyState>
          </div>
        ) : data === null ? (
          <div className="p-4 sm:p-5">
            <LoadingSkeleton rows={6} label={`در حال بارگذاری موجودی${selectedName ? ` انبار ${selectedName}` : ""}`} />
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>
              {data.items.length === 0
                ? "این انبار هنوز قلمی ندارد. اقلام را از «اقلام انبار» بسازید."
                : "قلمی با این فیلترها پیدا نشد."}
            </EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-border bg-stone-50 dark:bg-stone-900/40">
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">قلم</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:text-sm">موجودی</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:text-sm">وضعیت</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:text-sm">قیمت واحد</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:text-sm">ارزش</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((item) => {
                  const status = stockStatus(item);
                  return (
                    <tr key={item.id} className="border-b border-border/80 transition-colors last:border-b-0 hover:bg-stone-50/70 dark:hover:bg-stone-900/30">
                      <td className="px-4 py-3 sm:px-5">
                        <span className="font-medium text-foreground">{item.item_name}</span>
                        {item.sku ? (
                          <span className="ms-2 text-xs text-muted-foreground">{item.sku}</span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                        {formatQuantity(item.quantity)} {item.unit}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge tone={STATUS_META[status].tone}>{STATUS_META[status].label}</StatusBadge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground tabular-nums">
                        {money.format(Number(item.unit_cost))}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums">{money.format(Number(item.value_rial))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
