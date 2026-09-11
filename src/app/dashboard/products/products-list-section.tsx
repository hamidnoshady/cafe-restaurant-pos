"use client";

/**
 * Phase 42 — «لیست محصولات»: the trade's variant board as the reference's
 * product table — search, page size, pagination, a CSV download and the
 * per-row stock/price panel — composed from the platform's card, input and
 * money primitives instead of the reference's blue chrome.
 */
import { useCallback, useEffect, useMemo, useState, useDeferredValue } from "react";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { api, Field, inputClass } from "../ui";
import { EmptyState, SectionCard, SectionCardSkeleton } from "../page-chrome";
import type { VariantSummary } from "@/lib/accessories-service";

const PAGE_SIZES = [10, 20, 50] as const;

export function ProductsListSection({ apiBase }: { apiBase: string }) {
  const [items, setItems] = useState<VariantSummary[] | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState(0);
  const [panelFor, setPanelFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(() => {
    api<{ items: VariantSummary[] }>(`${apiBase}/items`).then(({ ok, data }) => {
      if (ok) setItems(data.items);
    });
  }, [apiBase]);
  useEffect(load, [load]);

  // Performance optimization: Pre-compute lowercased search strings to avoid O(N) recalculations
  // per keystroke. This index depends only on the base dataset.
  const searchIndex = useMemo(() => {
    if (!items) return null;
    return items.map((item) => ({
      item,
      normalized: [
        item.name.toLowerCase(),
        item.parentName?.toLowerCase() ?? "",
        item.sku?.toLowerCase() ?? "",
        item.barcode?.toLowerCase() ?? "",
      ].filter(Boolean),
    }));
  }, [items]);

  // Performance optimization: We depend on deferredSearch so typing remains snappy while
  // filtering happens in the background. We match against the pre-normalized index and check
  // individual fields to avoid false-positive cross-boundary matches.
  const filtered = useMemo(() => {
    if (!items || !searchIndex) return null;
    const needle = deferredSearch.trim().toLowerCase();
    if (!needle) return items;
    return searchIndex
      .filter(({ normalized }) => normalized.some((field) => field.includes(needle)))
      .map(({ item }) => item);
  }, [items, searchIndex, deferredSearch]);

  useEffect(() => setPage(0), [deferredSearch, pageSize]);

  const pageCount = filtered ? Math.max(1, Math.ceil(filtered.length / pageSize)) : 1;
  const safePage = Math.min(page, pageCount - 1);
  const rows = filtered?.slice(safePage * pageSize, safePage * pageSize + pageSize) ?? [];

  function downloadCsv() {
    if (!filtered) return;
    const head = ["نام", "خانواده", "کد کالا", "بارکد", "واحد", "موجودی", "قیمت فروش (ریال)", "قیمت خرید (ریال)"];
    const lines = filtered.map((item) =>
      [
        item.name,
        item.parentName ?? "",
        item.sku ?? "",
        item.barcode ?? "",
        item.unit ?? "",
        String(formatQuantity(item.quantity)),
        item.unitPrice != null ? String(item.unitPrice) : "",
        item.unitCost != null ? String(item.unitCost) : "",
      ]
        .map((cell) => `"${cell.replaceAll('"', '""')}"`)
        .join(","),
    );
    const blob = new Blob([`\uFEFF${[head.join(","), ...lines].join("\n")}`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "products.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <SectionCard
        title="لیست محصولات"
        description={
          filtered
            ? `صفحهٔ ${toPersianDigits(safePage + 1)} از ${toPersianDigits(pageCount)} (نتیجه ${toPersianDigits(filtered.length)})`
            : "در حال خواندن کالاها…"
        }
        actions={
          <>
            <div className="relative">
              <SearchIcon aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                className={`${inputClass} ps-9`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="فیلتر و جستجو: نام، کد یا بارکد"
                aria-label="جستجوی محصول"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              ردیف
              <select
                className={`${inputClass} w-auto min-h-9`}
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
            <Button type="button" variant="outline" size="sm" className="min-h-9" onClick={downloadCsv} disabled={!filtered || filtered.length === 0}>
              <DownloadIcon aria-hidden="true" className="size-4" />
              دانلود و چاپ
            </Button>
          </>
        }
        flush
      >
        {filtered === null ? (
          <div className="p-4 sm:p-5">
            <SectionCardSkeleton rows={6} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>کالایی ثبت نشده است؛ از «افزودن محصول» اولین کالا را ثبت کنید.</EmptyState>
          </div>
        ) : (
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-border/80 bg-muted/60 text-xs text-muted-foreground">
                  <th className="px-3 py-3 text-start font-medium">#</th>
                  <th className="px-3 py-3 text-start font-medium">نام</th>
                  <th className="px-3 py-3 text-start font-medium">کد کالا</th>
                  <th className="px-3 py-3 text-start font-medium">بارکد</th>
                  <th className="px-3 py-3 text-start font-medium">واحد اصلی</th>
                  <th className="px-3 py-3 text-start font-medium">موجودی</th>
                  <th className="px-3 py-3 text-start font-medium">قیمت فروش</th>
                  <th className="px-3 py-3 text-start font-medium">قیمت خرید</th>
                  <th className="px-3 py-3 text-start font-medium" aria-label="عملیات" />
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
              صفحهٔ {toPersianDigits(safePage + 1)} از {toPersianDigits(pageCount)}
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
      {notice ? <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p> : null}
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
  const isFamily = item.kind === "variant_parent";
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
        <td className="px-3 py-3 text-xs text-muted-foreground" dir="ltr">
          {item.barcode ?? "—"}
        </td>
        <td className="px-3 py-3 text-xs text-muted-foreground">{item.unit ?? "عدد"}</td>
        <td className="px-3 py-3 text-xs">{isFamily ? "—" : formatQuantity(item.quantity)}</td>
        <td className="px-3 py-3 text-xs">
          {isFamily ? "—" : item.unitPrice != null ? money.format(item.unitPrice) : "تعیین نشده"}
        </td>
        <td className="px-3 py-3 text-xs">
          {isFamily ? "—" : item.unitCost != null ? money.format(item.unitCost) : "تعیین نشده"}
        </td>
        <td className="px-3 py-3">
          {!isFamily ? (
            <Button type="button" variant="outline" size="sm" className="min-h-8 px-2 text-xs" onClick={onTogglePanel} disabled={busy}>
              ورود کالا / قیمت
            </Button>
          ) : null}
        </td>
      </tr>
      {panelOpen ? (
        <tr>
          <td colSpan={9} className="px-3 py-3">
            <StockPanel item={item} busy={busy} setBusy={setBusy} onSaved={onSaved} apiBase={apiBase} />
          </td>
        </tr>
      ) : null}
    </>
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
    setBusy(true);
    setError("");
    const { ok, data } = await api(`${apiBase}/items/${item.id}/stock`, {
      method: "POST",
      body: JSON.stringify({
        quantity: quantity.trim() || undefined,
        unitCost: quantity.trim() ? money.fromInput(Math.max(0, Math.round(Number(unitCost || 0)))) : undefined,
        unitPrice: unitPrice.trim() ? money.fromInput(Math.max(0, Math.round(Number(unitPrice || 0)))) : undefined,
      }),
    });
    setBusy(false);
    if (!ok) {
      setError(data.error === "no_cost_basis" ? "بهای تمام‌شده برای ورود کالا لازم است." : "ذخیره نشد؛ دوباره تلاش کنید.");
      return;
    }
    onSaved();
  }

  return (
    <form onSubmit={save} className="rounded-xl bg-amber-50/60 dark:bg-amber-500/15 p-3 sm:p-4">
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Field label="تعداد ورودی" hint="برای ثبت فقط قیمت، خالی بگذارید.">
          <PersianNumberInput value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </Field>
        <Field label={`بهای تمام‌شده هر واحد (${money.unitLabel})`}>
          <PersianNumberInput value={unitCost} onChange={(event) => setUnitCost(event.target.value)} />
        </Field>
        <Field label={`قیمت فروش هر واحد (${money.unitLabel})`}>
          <PersianNumberInput value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button type="submit" disabled={busy} size="sm" className="min-h-9 border border-amber-300 dark:border-amber-500/40 px-4 font-semibold">
          ذخیره
        </Button>
        {error ? <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}
      </div>
    </form>
  );
}
