"use client";

/**
 * Phase 42 — «لیست محصولات»: the trade's variant board as the reference's
 * product table — search, page size, pagination, a CSV download and the
 * per-row stock/price panel — composed from the platform's card, input and
 * money primitives instead of the reference's blue chrome.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useDeferredValue, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import {
  buildProductsCsv,
  isVariantParent,
  normalizeListSearch,
  variantMatchesNeedle,
  variantSearchNeedles,
} from "@/lib/product-list";
import { api, errorMessage, Field, inputClass } from "../ui";
import { EmptyState, LoadingSkeleton, SectionCard } from "../page-chrome";
import type { VariantSummary } from "@/lib/accessories-service";

const PAGE_SIZES = [10, 20, 50] as const;

export function ProductsListSection({ apiBase }: { apiBase: string }) {
  const [items, setItems] = useState<VariantSummary[] | null>(null);
  // A failed read used to leave the skeleton on screen forever with no way
  // out; keep the failure explicit so the card can offer a retry instead.
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState(0);
  const [panelFor, setPanelFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(() => {
    setLoadError(false);
    api<{ items: VariantSummary[] }>(`${apiBase}/items`).then(({ ok, data }) => {
      if (ok) {
        setItems(data.items);
      } else {
        setLoadError(true);
      }
    });
  }, [apiBase]);
  useEffect(load, [load]);

  // Performance optimization: Pre-compute the search needles to avoid O(N)
  // recalculations per keystroke. This index depends only on the base dataset;
  // needles are digit-folded so a Persian-keyboard query («۱۰۱۳») matches the
  // Latin SKUs/barcodes the catalogue stores.
  const searchIndex = useMemo(() => {
    if (!items) return null;
    return items.map((item) => ({ item, needles: variantSearchNeedles(item) }));
  }, [items]);

  // Performance optimization: We depend on deferredSearch so typing remains
  // snappy while filtering happens in the background. Field-level needles
  // avoid false-positive cross-boundary matches.
  const needle = normalizeListSearch(deferredSearch);
  const filtered = useMemo(() => {
    if (!items || !searchIndex) return null;
    if (!needle) return items;
    return searchIndex
      .filter(({ needles }) => variantMatchesNeedle(needles, needle))
      .map(({ item }) => item);
  }, [items, searchIndex, needle]);

  useEffect(() => setPage(0), [deferredSearch, pageSize]);

  const searching = needle.length > 0;
  const pageCount = filtered ? Math.max(1, Math.ceil(filtered.length / pageSize)) : 1;
  const safePage = Math.min(page, pageCount - 1);
  const rows = filtered?.slice(safePage * pageSize, safePage * pageSize + pageSize) ?? [];

  function downloadCsv() {
    if (!filtered) return;
    const blob = new Blob([buildProductsCsv(filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "products.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const description =
    filtered === null
      ? loadError
        ? "خواندن کالاها ممکن نشد"
        : "در حال خواندن کالاها…"
      : searching
        ? `${toPersianDigits(filtered.length)} نتیجه از ${toPersianDigits(items?.length ?? 0)} کالا`
        : `صفحهٔ ${toPersianDigits(safePage + 1)} از ${toPersianDigits(pageCount)} (${toPersianDigits(filtered.length)} کالا)`;

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <SectionCard
        title="لیست محصولات"
        description={description}
        // Search box + row-size select + download: on a phone they take their
        // own full row under the title rather than squeezing beside it.
        actionsClassName="max-sm:w-full"
        actions={
          <>
            <div className="relative min-w-0 max-sm:flex-1 sm:w-72">
              <SearchIcon aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                className={`${inputClass} ps-9`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="فیلتر و جستجو: نام، کد یا بارکد"
                aria-label="جستجوی محصول"
              />
            </div>
            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              ردیف
              <select
                className={`${inputClass} w-auto`}
                value={pageSize}
                onChange={(event) => setPageSize(Number(event.target.value))}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {toPersianDigits(size)}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="outline" size="sm" className="min-h-9 shrink-0" onClick={downloadCsv} disabled={!filtered || filtered.length === 0}>
              <DownloadIcon aria-hidden="true" className="size-4" />
              دانلود CSV
            </Button>
          </>
        }
        flush
      >
        {filtered === null ? (
          loadError ? (
            <div className="p-4 sm:p-5">
              <div className="rounded-xl border border-dashed border-rose-300 py-6 text-center text-sm dark:border-rose-500/40">
                <p className="text-rose-600 dark:text-rose-400">کالاها خوانده نشد؛ اتصال را بررسی کنید.</p>
                <Button type="button" variant="outline" size="sm" className="mt-3 min-h-9" onClick={load}>
                  تلاش دوباره
                </Button>
              </div>
            </div>
          ) : (
            <div className="p-4 sm:p-5">
              <LoadingSkeleton rows={6} label="در حال خواندن کالاها" />
            </div>
          )
        ) : filtered.length === 0 ? (
          <div className="p-4 sm:p-5">
            {searching ? (
              <div className="space-y-3">
                <EmptyState>برای «{deferredSearch.trim()}» کالایی پیدا نشد.</EmptyState>
                <div className="text-center">
                  <Button type="button" variant="outline" size="sm" className="min-h-9" onClick={() => setSearch("")}>
                    پاک کردن جستجو
                  </Button>
                </div>
              </div>
            ) : (
              <EmptyState>کالایی ثبت نشده است؛ از «افزودن محصول» اولین کالا را ثبت کنید.</EmptyState>
            )}
          </div>
        ) : (
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-border/80 bg-muted/60 text-xs text-muted-foreground">
                  <th className="whitespace-nowrap px-3 py-3 text-start font-medium">#</th>
                  <th className="px-3 py-3 text-start font-medium">نام</th>
                  <th className="whitespace-nowrap px-3 py-3 text-start font-medium">کد کالا</th>
                  <th className="whitespace-nowrap px-3 py-3 text-start font-medium">بارکد</th>
                  <th className="whitespace-nowrap px-3 py-3 text-start font-medium">واحد اصلی</th>
                  <th className="whitespace-nowrap px-3 py-3 text-start font-medium">موجودی</th>
                  <th className="whitespace-nowrap px-3 py-3 text-start font-medium">قیمت فروش</th>
                  <th className="whitespace-nowrap px-3 py-3 text-start font-medium">قیمت خرید</th>
                  <th className="whitespace-nowrap px-3 py-3 text-start font-medium" aria-label="عملیات" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/80">
                {rows.map((item, index) => (
                  <ProductRow
                    key={item.id}
                    item={item}
                    index={safePage * pageSize + index + 1}
                    apiBase={apiBase}
                    busy={busy}
                    setBusy={setBusy}
                    panelOpen={panelFor === item.id}
                    onTogglePanel={() => {
                      setNotice("");
                      setPanelFor((current) => (current === item.id ? null : item.id));
                    }}
                    onSaved={() => {
                      setNotice("ذخیره شد.");
                      load();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {filtered && filtered.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/80 bg-muted/40 px-4 py-3">
            <p className="text-xs text-muted-foreground">
              {searching
                ? `${toPersianDigits(filtered.length)} نتیجه — صفحهٔ ${toPersianDigits(safePage + 1)} از ${toPersianDigits(pageCount)}`
                : `صفحهٔ ${toPersianDigits(safePage + 1)} از ${toPersianDigits(pageCount)}`}
            </p>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="sm" className="size-8 p-0" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} aria-label="صفحهٔ قبل">
                <ChevronRightIcon aria-hidden="true" className="size-4" />
              </Button>
              <Button type="button" variant="ghost" size="sm" className="size-8 p-0" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)} aria-label="صفحهٔ بعد">
                <ChevronLeftIcon aria-hidden="true" className="size-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </SectionCard>
      {notice ? (
        <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function ProductRow({
  item,
  index,
  apiBase,
  busy,
  setBusy,
  panelOpen,
  onTogglePanel,
  onSaved,
}: {
  item: VariantSummary;
  index: number;
  apiBase: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onSaved: () => void;
}) {
  const money = useMoney();
  const isFamily = isVariantParent(item);
  return (
    <>
      <tr className={isFamily ? "bg-muted/60" : ""}>
        <td className="px-3 py-3 text-xs text-muted-foreground">{toPersianDigits(index)}</td>
        <td className="px-3 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-foreground">{item.name}</span>
            {isFamily ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground/80">خانواده</span>
            ) : null}
            {!isFamily && item.parentName ? (
              <span className="text-xs text-muted-foreground">{item.parentName}</span>
            ) : null}
            {item.attributes.map((attribute) => (
              <span
                key={attribute.name}
                className="rounded-full bg-amber-100 dark:bg-amber-500/20 px-2 py-0.5 text-xs text-amber-950 dark:text-amber-200"
              >
                {attribute.name}: {attribute.value}
              </span>
            ))}
            {!item.isSellable ? (
              <span className="rounded-full bg-rose-100 dark:bg-rose-500/20 px-2 py-0.5 text-xs text-rose-950 dark:text-rose-200">
                غیر قابل فروش
              </span>
            ) : null}
          </div>
        </td>
        <td className="px-3 py-3 text-xs text-muted-foreground">{item.sku ?? "—"}</td>
        <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground" dir="ltr">
          {item.barcode ?? "—"}
        </td>
        <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{item.unit ?? "عدد"}</td>
        <td className="whitespace-nowrap px-3 py-3 text-xs">{isFamily ? "—" : formatQuantity(item.quantity)}</td>
        <td className="whitespace-nowrap px-3 py-3 text-xs">
          {isFamily ? "—" : item.unitPrice != null ? money.format(item.unitPrice) : "تعیین نشده"}
        </td>
        <td className="whitespace-nowrap px-3 py-3 text-xs">
          {isFamily ? "—" : item.unitCost != null ? money.format(item.unitCost) : "تعیین نشده"}
        </td>
        <td className="px-3 py-3">
          {!isFamily ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-8 whitespace-nowrap px-2 text-xs"
              onClick={onTogglePanel}
              disabled={busy}
              aria-expanded={panelOpen}
            >
              ورود کالا / قیمت
            </Button>
          ) : null}
        </td>
      </tr>
      {panelOpen ? (
        <tr>
          <td colSpan={9} className="px-3 py-3">
            <PanelShell>
              <StockPanel item={item} busy={busy} setBusy={setBusy} onSaved={onSaved} apiBase={apiBase} />
            </PanelShell>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * The expanded row lives inside the wide table, which scrolls sideways on
 * small screens — an uncapped panel is as wide as the table (min-width 52rem)
 * and a phone user has to scroll sideways to reach its fields. Cap it at the
 * scroll container's *visible* width, measured directly: viewport math cannot
 * know the sidebar and page padding at every breakpoint, and RTL horizontal
 * sticky positioning is unreliable across browsers.
 */
function PanelShell({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | null>(null);
  useEffect(() => {
    const scroller = ref.current?.closest("div.overflow-x-auto");
    if (!(scroller instanceof HTMLElement)) return;
    const fit = () => {
      if (scroller.clientWidth > 0) setAvailable(scroller.clientWidth);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  return (
    // 12px: the cell's own inline-end padding, so the panel's far edge stays
    // off the scroll edge. Hidden until the first measure to avoid a flash of
    // table-wide panel on narrow screens. `sticky start-0` then keeps the
    // width-capped panel glued to the table's visible start edge even when
    // the user had scrolled the table to reach the row's toggle button —
    // without it the panel would reopen off-screen under the user's finger.
    <div
      ref={ref}
      className={available == null ? "invisible" : "sticky start-0"}
      style={available != null ? { maxWidth: available - 12 } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * The same receipt/price panel the old «کالاها» board carried — stock and the
 * shelf price stay one write path with the trade's own stock route.
 */
function StockPanel({
  item,
  busy,
  setBusy,
  onSaved,
  apiBase,
}: {
  item: VariantSummary;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onSaved: () => void;
  apiBase: string;
}) {
  const money = useMoney();
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [unitPrice, setUnitPrice] = useState(
    item.unitPrice != null ? String(money.toInput(item.unitPrice)) : "",
  );
  const [error, setError] = useState("");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const quantityText = quantity.trim();
    const unitCostText = unitCost.trim();
    const unitPriceText = unitPrice.trim();

    // Client-side copies of the server's rules (validateStockReceipt in
    // lib/accessories.ts): checking them here keeps a no-op submit from being
    // announced as a success and keeps an empty «بهای تمام‌شده» from being
    // silently coerced to ۰ — which used to roll the weighted-average cost
    // down to zero while looking like a valid receipt.
    if (!quantityText && !unitPriceText && !unitCostText) {
      setError("تعداد ورودی یا قیمت فروش را وارد کنید.");
      return;
    }
    const quantityValue = quantityText ? Number(quantityText) : null;
    if (quantityValue != null && (!Number.isFinite(quantityValue) || quantityValue <= 0)) {
      setError("تعداد ورودی باید بزرگ‌تر از صفر باشد.");
      return;
    }
    if (quantityText && !unitCostText) {
      setError("بهای تمام‌شده برای ورود کالا لازم است.");
      return;
    }
    if (!quantityText && unitCostText) {
      setError("برای ثبت بهای تمام‌شده، تعداد ورودی را هم وارد کنید.");
      return;
    }
    const unitCostValue = unitCostText ? Number(unitCostText) : null;
    if (unitCostValue != null && !Number.isFinite(unitCostValue)) {
      setError("بهای تمام‌شده نامعتبر است.");
      return;
    }
    const unitPriceValue = unitPriceText ? Number(unitPriceText) : null;
    if (unitPriceValue != null && !Number.isFinite(unitPriceValue)) {
      setError("قیمت فروش نامعتبر است.");
      return;
    }

    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(`${apiBase}/items/${item.id}/stock`, {
      method: "POST",
      body: JSON.stringify({
        quantity: quantityText || undefined,
        unitCost: quantityText ? money.fromInput(Math.round(unitCostValue ?? 0)) : undefined,
        unitPrice: unitPriceText ? money.fromInput(Math.round(unitPriceValue ?? 0)) : undefined,
      }),
    });
    setBusy(false);
    if (!ok) {
      // The stock routes answer validation failures with a free-text Persian
      // `message` («تعداد ورودی باید بزرگ‌تر از صفر باشد.»); surface it.
      // Coded failures (session, industry, …) go through the shared message
      // map instead of falling back to a bare «try again».
      setError(data.message?.trim() || errorMessage(data.error));
      return;
    }
    // Clear the receipt fields so a distracted second click does not receive
    // the same stock twice; the price field already shows what was saved.
    setQuantity("");
    setUnitCost("");
    onSaved();
  }

  return (
    <form onSubmit={save} className="rounded-xl bg-amber-50/60 dark:bg-amber-500/15 p-3 sm:p-4">
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Field label="تعداد ورودی" hint="برای ثبت فقط قیمت، خالی بگذارید.">
          <PersianNumberInput
            className={inputClass}
            value={quantity}
            onChange={(event) => {
              setQuantity(event.target.value);
              setError("");
            }}
            inputMode="decimal"
            allowNegative={false}
            autoFocus
          />
        </Field>
        <Field label={`بهای تمام‌شده هر واحد (${money.unitLabel})`}>
          <PersianNumberInput
            className={inputClass}
            value={unitCost}
            onChange={(event) => {
              setUnitCost(event.target.value);
              setError("");
            }}
            inputMode="numeric"
            allowNegative={false}
          />
        </Field>
        <Field label={`قیمت فروش هر واحد (${money.unitLabel})`}>
          <PersianNumberInput
            className={inputClass}
            value={unitPrice}
            onChange={(event) => {
              setUnitPrice(event.target.value);
              setError("");
            }}
            inputMode="numeric"
            allowNegative={false}
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy} size="sm" className="min-h-9 border border-amber-300 dark:border-amber-500/40 px-4 font-semibold">
          ذخیره
        </Button>
        {error ? (
          <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
