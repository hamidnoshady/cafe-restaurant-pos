"use client";

/**
 * Phase 42 — «لیست قیمت»: the reference's price-update matrix on the
 * platform's chrome. Sale and purchase columns write the trade's own stock
 * route (the one writer the invoice screen trusts); named list columns write
 * `price_list_entries`. «بروزرسانی سریع» moves a whole column by percent or
 * amount with an optional round, and the lists modal adds/renames/deletes the
 * named lists themselves.
 */
import { useCallback, useEffect, useMemo, useState, useDeferredValue } from "react";
import { FileSpreadsheetIcon, PencilIcon, PlusIcon, RefreshCwIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import type { VariantSummary } from "@/lib/accessories-service";
import type { PriceEntry, PriceList } from "@/lib/price-lists-service";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { EmptyState, SectionCard, SectionCardSkeleton } from "../page-chrome";
import { SearchField } from "@/app/dashboard/filters";

type ColumnKey = string; // "sale" | "purchase" | <price list id>

export function PriceListsSection({ apiBase }: { apiBase: string }) {
  const money = useMoney();
  const [items, setItems] = useState<VariantSummary[] | null>(null);
  const [lists, setLists] = useState<PriceList[]>([]);
  const [cells, setCells] = useState<Record<string, Record<ColumnKey, string>>>({});
  const [initial, setInitial] = useState<Record<string, Record<ColumnKey, string>>>({});
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [listsModal, setListsModal] = useState(false);
  const [quickModal, setQuickModal] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      api<{ items: VariantSummary[] }>(`${apiBase}/items`),
      api<{ lists: PriceList[]; entries: PriceEntry[] }>("/api/products/price-lists"),
    ]).then(([itemsRes, listsRes]) => {
      if (!itemsRes.ok || !listsRes.ok) return;
      const priced = itemsRes.data.items.filter((item) => item.kind !== "variant_parent");
      setItems(priced);
      setLists(listsRes.data.lists);

      const entryPrice = new Map(listsRes.data.entries.map((e) => [`${e.priceListId}:${e.itemId}`, e.price]));
      const next: Record<string, Record<ColumnKey, string>> = {};
      for (const item of priced) {
        const row: Record<ColumnKey, string> = {
          sale: item.unitPrice != null ? String(money.toInput(item.unitPrice)) : "",
          purchase: item.unitCost != null ? String(money.toInput(item.unitCost)) : "",
        };
        for (const list of listsRes.data.lists) {
          const price = entryPrice.get(`${list.id}:${item.id}`);
          row[list.id] = price != null ? String(money.toInput(price)) : "";
        }
        next[item.id] = row;
      }
      setCells(next);
      setInitial(JSON.parse(JSON.stringify(next)) as typeof next);
    });
  }, [apiBase, money]);
  useEffect(load, [load]);

  // Performance optimization: Pre-compute lowercased search strings to avoid O(N) recalculations
  // per keystroke. This index depends only on the base dataset.
  const searchIndex = useMemo(() => {
    if (!items) return null;
    return items.map((item) => ({
      item,
      normalized: [
        item.name.toLowerCase(),
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

  function setCell(itemId: string, column: ColumnKey, value: string) {
    setCells((current) => ({
      ...current,
      [itemId]: { ...current[itemId], [column]: value },
    }));
  }

  function dirtyUpdates() {
    const updates: { itemId: string; column: ColumnKey; price: number | null }[] = [];
    for (const item of filtered ?? []) {
      const row = cells[item.id] ?? {};
      const base = initial[item.id] ?? {};
      for (const [column, value] of Object.entries(row)) {
        if ((base[column] ?? "") === value) continue;
        updates.push({
          itemId: item.id,
          column,
          price: value.trim() === "" ? null : money.fromInput(Math.max(0, Number(value))),
        });
      }
    }
    return updates;
  }

  async function saveAll() {
    const updates = dirtyUpdates();
    if (updates.length === 0) {
      setNotice("تغییری برای ذخیره نیست.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const entryUpdates = updates.filter((u) => u.column !== "sale" && u.column !== "purchase");
    const stockUpdates = updates.filter((u) => u.column === "sale" || u.column === "purchase");

    let failed = false;
    if (entryUpdates.length > 0) {
      const { ok } = await api("/api/products/price-lists/entries", {
        method: "PUT",
        body: JSON.stringify({
          updates: entryUpdates.map((u) => ({ priceListId: u.column, itemId: u.itemId, price: u.price })),
        }),
      });
      failed = !ok;
    }
    for (const update of stockUpdates) {
      if (update.price == null) continue; // clearing sale/purchase is not a stock write
      const { ok } = await api(`${apiBase}/items/${update.itemId}/stock`, {
        method: "POST",
        body: JSON.stringify(
          update.column === "sale" ? { unitPrice: update.price } : { unitCost: update.price },
        ),
      });
      failed = failed || !ok;
    }
    setBusy(false);
    if (failed) {
      setError("برخی قیمت‌ها ذخیره نشد؛ دوباره تلاش کنید.");
      return;
    }
    setNotice("قیمت‌ها ذخیره شد.");
    load();
  }

  function downloadCsv() {
    if (!filtered) return;
    const head = ["کد کالا", "عنوان کالا", "قیمت فروش (ریال)", "قیمت خرید (ریال)", ...lists.map((l) => `${l.name} (ریال)`)];
    const lines = filtered.map((item) => {
      const row = cells[item.id] ?? {};
      const toRial = (value: string) => (value.trim() === "" ? "" : String(money.fromInput(Number(value))));
      return [
        item.sku ?? "",
        item.name,
        toRial(row.sale ?? ""),
        toRial(row.purchase ?? ""),
        ...lists.map((list) => toRial(row[list.id] ?? "")),
      ]
        .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
        .join(",");
    });
    const blob = new Blob([`\uFEFF${[head.join(","), ...lines].join("\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "price-lists.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={downloadCsv} disabled={!filtered || filtered.length === 0}>
          <FileSpreadsheetIcon aria-hidden="true" className="size-4" />
          دانلود اکسل لیست قیمت
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setQuickModal(true)}>
          <RefreshCwIcon aria-hidden="true" className="size-4" />
          بروزرسانی سریع
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setListsModal(true)}>
          <PlusIcon aria-hidden="true" className="size-4" />
          افزودن لیست قیمت
        </Button>
        <Button type="button" size="sm" onClick={saveAll} disabled={busy}>
          <SaveIcon aria-hidden="true" className="size-4" />
          ذخیره قیمت‌ها
        </Button>
      </div>

      <SectionCard
        title="نمایش لیست قیمت‌های کالا"
        description={filtered ? `${toPersianDigits(filtered.length)} کالا` : "در حال خواندن…"}
        actions={
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="فیلتر و جستجو"
            label="جستجوی کالا"
          />
        }
        flush
      >
        {filtered === null ? (
          <div className="p-4 sm:p-5">
            <SectionCardSkeleton rows={6} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>کالایی برای قیمت‌گذاری ثبت نشده است.</EmptyState>
          </div>
        ) : (
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <thead>
                <tr className="border-b border-border/80 bg-muted/60 text-xs text-muted-foreground">
                  <th className="px-3 py-3 text-start font-medium">#</th>
                  <th className="px-3 py-3 text-start font-medium">کد کالا</th>
                  <th className="px-3 py-3 text-start font-medium">عنوان کالا</th>
                  <th className="px-3 py-3 text-start font-medium">قیمت فروش</th>
                  <th className="px-3 py-3 text-start font-medium">قیمت خرید</th>
                  {lists.map((list) => (
                    <th key={list.id} className="px-3 py-3 text-start font-medium">
                      {list.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/80">
                {filtered.map((item, index) => (
                  <tr key={item.id}>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{toPersianDigits(index + 1)}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground" dir="ltr">
                      {item.sku ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-medium text-foreground">{item.name}</td>
                    {(["sale", "purchase"] as const).map((column) => (
                      <td key={column} className="px-3 py-2">
                        <PriceCell value={cells[item.id]?.[column] ?? ""} onChange={(value) => setCell(item.id, column, value)} />
                      </td>
                    ))}
                    {lists.map((list) => (
                      <td key={list.id} className="px-3 py-2">
                        <PriceCell value={cells[item.id]?.[list.id] ?? ""} onChange={(value) => setCell(item.id, list.id, value)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
      {notice ? <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p> : null}

      <ListsModal
        open={listsModal}
        onOpenChange={setListsModal}
        lists={lists}
        onChanged={load}
      />
      <QuickUpdateModal
        open={quickModal}
        onOpenChange={setQuickModal}
        lists={lists}
        onApplied={() => {
          load();
          setNotice("بروزرسانی سریع اعمال شد.");
        }}
      />
    </div>
  );
}

function PriceCell({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <PersianNumberInput
      className={`${inputClass} min-h-9 text-xs`}
      dir="ltr"
      inputMode="numeric"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="—"
    />
  );
}

/** The «لیست قیمت‌ها» modal: add, rename and delete the named lists. */
function ListsModal({
  open,
  onOpenChange,
  lists,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lists: PriceList[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api("/api/products/price-lists", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() }),
    });
    setBusy(false);
    if (!ok) {
      setError(data.error === "duplicate_name" ? "لیستی با همین نام وجود دارد." : "ثبت نشد.");
      return;
    }
    setName("");
    onChanged();
  }

  async function rename(id: string) {
    setBusy(true);
    const { ok } = await api(`/api/products/price-lists/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: editName }),
    });
    setBusy(false);
    if (ok) {
      setEditing(null);
      onChanged();
    }
  }

  async function remove(id: string) {
    setBusy(true);
    const { ok } = await api(`/api/products/price-lists/${id}`, { method: "DELETE" });
    setBusy(false);
    if (ok) onChanged();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>لیست قیمت‌ها</DialogTitle>
        </DialogHeader>
        <ul className="space-y-2">
          {lists.map((list) => (
            <li key={list.id} className="flex items-center gap-2 rounded-xl border border-border/80 bg-muted/40 px-3 py-2">
              {editing === list.id ? (
                <input
                  className={`${inputClass} min-h-9`}
                  value={editName}
                  onChange={(event) => setEditName(event.target.value)}
                  autoFocus
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {list.name} <span className="text-xs text-muted-foreground">({list.currency})</span>
                </span>
              )}
              {editing === list.id ? (
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => rename(list.id)}>
                  ذخیره
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-8 p-0"
                    aria-label={`ویرایش ${list.name}`}
                    onClick={() => {
                      setEditing(list.id);
                      setEditName(list.name);
                    }}
                  >
                    <PencilIcon aria-hidden="true" className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-8 p-0 text-rose-600 dark:text-rose-400"
                    aria-label={`حذف ${list.name}`}
                    disabled={busy}
                    onClick={() => remove(list.id)}
                  >
                    <Trash2Icon aria-hidden="true" className="size-4" />
                  </Button>
                </>
              )}
            </li>
          ))}
          {lists.length === 0 ? <li className="text-xs text-muted-foreground">لیست قیمتی تعریف نشده است.</li> : null}
        </ul>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <div className="flex w-full items-center gap-2">
            <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="نام لیست جدید (مثلاً عمده)" />
            <Button type="button" disabled={busy} onClick={add}>
              <PlusIcon aria-hidden="true" className="size-4" />
              افزودن لیست قیمت
            </Button>
          </div>
          {error ? <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The «تغییر قیمت سریع» modal: percent/amount over one column, optional round. */
function QuickUpdateModal({
  open,
  onOpenChange,
  lists,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lists: PriceList[];
  onApplied: () => void;
}) {
  const [target, setTarget] = useState<string>("sale");
  const [mode, setMode] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState("");
  const [round, setRound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function apply() {
    const numeric = Number(value);
    if (value.trim() === "" || !Number.isFinite(numeric)) {
      setError("مقدار تغییر را وارد کنید.");
      return;
    }
    setBusy(true);
    setError("");
    const targetBody =
      target === "sale"
        ? { kind: "sale" }
        : target === "purchase"
          ? { kind: "purchase" }
          : { kind: "list", priceListId: target };
    const { ok } = await api("/api/products/price-lists/quick-update", {
      method: "POST",
      body: JSON.stringify({ target: targetBody, mode, value: numeric, round }),
    });
    setBusy(false);
    if (!ok) {
      setError("اعمال نشد؛ دوباره تلاش کنید.");
      return;
    }
    onOpenChange(false);
    onApplied();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>تغییر قیمت سریع</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="اعمال بر لیست">
            <select className={inputClass} value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="sale">قیمت فروش</option>
              <option value="purchase">قیمت خرید</option>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-center gap-2">
            <select
              className={`${inputClass} w-auto`}
              value={mode}
              onChange={(event) => setMode(event.target.value as "percent" | "amount")}
              aria-label="نوع تغییر"
            >
              <option value="percent">افزایش ٪</option>
              <option value="amount">افزایش مبلغی</option>
            </select>
            <PersianNumberInput className={inputClass} dir="ltr" value={value} onChange={(event) => setValue(event.target.value)} placeholder="۱" />
            {mode === "percent" ? <span className="text-sm text-muted-foreground">٪</span> : null}
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={round} onChange={(event) => setRound(event.target.checked)} className="size-4 accent-amber-600" />
            گرد کردن (هزار تومان)
          </label>
          {error ? <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" className="w-full" disabled={busy} onClick={apply}>
            اعمال تغییرات
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
