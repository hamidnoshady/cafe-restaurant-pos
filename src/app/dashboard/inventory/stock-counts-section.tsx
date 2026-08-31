"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Decimal from "decimal.js";
import { PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { useInventorySearch } from "@/lib/inventory-search";
import { api, errorMessage, Field, inputClass, PrimaryButton } from "../ui";
import { CountScanField, type ScanMatch } from "./count-scan-field";
import type { InventoryItem, Runner } from "./inventory-manager";
import { cardClass, overlayPanelClass } from "../page-chrome";

interface StockCount {
  id: string;
  note: string | null;
  counted_at: string;
  counted_by_name: string | null;
  line_count: string | number;
}

interface CountLine {
  id: string;
  inventoryItemId: string;
  itemName: string;
  unit: string;
  systemQty: string;
  countedQty: string;
  variance: string;
  unitCarryingCost: string;
  varianceValue: string;
}

interface CountDetail {
  id: string;
  note: string | null;
  countedAt: string;
  countedByName: string | null;
  lines: CountLine[];
}

function countError(code: string | undefined): string {
  const map: Record<string, string> = {
    count_not_found: "این شمارش پیدا نشد.",
    count_not_reversible: "این شمارش قابل اصلاح نیست.",
    already_reversed: "این شمارش قبلاً اصلاح یا حذف شده است.",
    count_layer_settled:
      "بخشی از کسری این شمارش بعداً با خرید یا شمارش دیگری تسویه شده و قابل اصلاح نیست.",
    count_stock_consumed:
      "موجودی اضافهٔ این شمارش بعداً مصرف شده و قابل اصلاح نیست؛ یک شمارش جدید ثبت کنید.",
    stock_count_reversal_inconsistent:
      "اصلاح این شمارش با سوابق موجودی ناسازگار است.",
  };
  return map[code ?? ""] ?? errorMessage(code);
}

export function StockCountsSection({
  items,
  busy,
  run,
}: {
  items: InventoryItem[];
  busy: boolean;
  run: Runner;
}) {
  const [counts, setCounts] = useState<StockCount[] | null>(null);
  const [note, setNote] = useState("");
  const [countedQty, setCountedQty] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Items reached by the scanner this session, newest first — pinned above
   *  the full list so a warehouse of thousands stays legible while counting. */
  const [scannedIds, setScannedIds] = useState<string[]>([]);
  const countedQtyRef = useRef<Record<string, string>>({});

  const loadCounts = useCallback(() => {
    api<{ counts: StockCount[] }>("/api/inventory/stock-counts").then(
      ({ ok, data }) => {
        if (ok) setCounts(data.counts);
      },
    );
  }, []);
  useEffect(loadCounts, [loadCounts]);

  const activeItems = useMemo(() => items.filter((i) => i.is_active), [items]);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const visibleItems = useInventorySearch(activeItems, deferredSearchQuery);

  const activeIds = useMemo(() => new Set(activeItems.map((i) => i.id)), [activeItems]);
  const isCountable = useCallback((id: string) => activeIds.has(id), [activeIds]);

  // Scanning the same barcode twice means "two of them", so a scan *adds* to
  // the tally rather than replacing it. Decimal, not float: a store room
  // counted in kg would otherwise drift (0.1 + 0.2) after a few hundred reads.
  const handleScan = useCallback((match: ScanMatch, qty: number) => {
    setScannedIds((prev) =>
      prev.includes(match.inventoryItemId) ? prev : [match.inventoryItemId, ...prev],
    );
    setCountedQty((prev) => {
      const current = prev[match.inventoryItemId]?.trim();
      const base = current && Number.isFinite(Number(current)) ? new Decimal(current) : new Decimal(0);
      return { ...prev, [match.inventoryItemId]: base.plus(qty).toFixed() };
    });
  }, []);

  const runningTotal = useCallback(
    (inventoryItemId: string) => countedQtyRef.current[inventoryItemId],
    [],
  );

  // The scan field reads the tally back after the parent state settles; a ref
  // keeps that read stable so the callback identity never churns per keystroke.
  useEffect(() => {
    countedQtyRef.current = countedQty;
  }, [countedQty]);

  const scannedItems = useMemo(
    () =>
      scannedIds
        .map((id) => activeItems.find((i) => i.id === id))
        .filter((i): i is InventoryItem => Boolean(i)),
    [scannedIds, activeItems],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const lines = activeItems
      .filter((i) => countedQty[i.id]?.trim())
      .map((i) => ({
        inventoryItemId: i.id,
        countedQty: countedQty[i.id].trim(),
      }));
    if (lines.length === 0) return;

    const ok = await run(() =>
      api("/api/inventory/stock-counts", {
        method: "POST",
        body: JSON.stringify({ note, lines }),
      }),
    );
    if (ok) {
      setNote("");
      setCountedQty({});
      setScannedIds([]);
      loadCounts();
    }
  }

  return (
    <div className="space-y-6">
      <section className={`min-w-0 ${cardClass} p-5`}>
        <h2 className="mb-1 font-semibold">شمارش فیزیکی انبار</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          فقط اقلامی که مقدار شمارش‌شده برایشان وارد شود ثبت می‌شوند؛ اختلاف با
          موجودی سیستم به‌صورت خودکار به‌عنوان اصلاحیه ثبت می‌شود.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <CountScanField
            onScan={handleScan}
            isCountable={isCountable}
            runningTotal={runningTotal}
          />
          {scannedItems.length > 0 ? (
            <div className="rounded-lg border border-border">
              <div className="flex items-center justify-between px-3 py-2 text-xs font-medium">
                <span>اقلام اسکن‌شده ({toPersianDigits(scannedItems.length)})</span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    setScannedIds([]);
                    setCountedQty((prev) => {
                      const next = { ...prev };
                      for (const id of scannedIds) delete next[id];
                      return next;
                    });
                  }}
                >
                  پاک کردن اسکن‌ها
                </button>
              </div>
              <ul className="divide-y divide-border border-t border-border">
                {scannedItems.map((i) => (
                  <li
                    key={i.id}
                    className="flex min-w-0 flex-col gap-2 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="min-w-0 break-words">
                      {i.name}{" "}
                      <span className="text-xs text-muted-foreground">
                        (موجودی سیستم: {formatQuantity(i.stock)} {i.unit})
                      </span>
                    </span>
                    <label className="grid w-full gap-1 text-xs font-medium sm:w-40">
                      <span>مقدار شمارش‌شده</span>
                      <PersianNumberInput
                        className={inputClass}
                        dir="ltr"
                        inputMode="decimal"
                        value={countedQty[i.id] ?? ""}
                        onChange={(e) =>
                          setCountedQty((prev) => ({ ...prev, [i.id]: e.target.value }))
                        }
                      />
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <Field label="یادداشت">
            <input
              className={inputClass}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="اختیاری"
            />
          </Field>
          <Field label="جستجو">
            <div className="relative">
              <SearchIcon
                className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                className={`${inputClass} ps-9`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="نام یا کد قلم…"
              />
            </div>
          </Field>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {visibleItems.map((i) => (
              <li
                key={i.id}
                className="flex min-w-0 flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0 break-words">
                  {i.name}{" "}
                  <span className="text-xs text-muted-foreground">
                    (موجودی سیستم: {formatQuantity(i.stock)} {i.unit})
                  </span>
                </span>
                <label className="grid w-full gap-1 text-xs font-medium sm:w-40">
                  <span>مقدار شمارش‌شده</span>
                  <PersianNumberInput
                    className={inputClass}
                    dir="ltr"
                    inputMode="decimal"
                    value={countedQty[i.id] ?? ""}
                    onChange={(e) =>
                      setCountedQty((prev) => ({
                        ...prev,
                        [i.id]: e.target.value,
                      }))
                    }
                  />
                </label>
              </li>
            ))}
          </ul>
          {visibleItems.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              {searchQuery.trim()
                ? "قلمی با این جستجو یافت نشد."
                : "قلم فعالی برای شمارش موجود نیست."}
            </p>
          ) : null}
          <PrimaryButton disabled={busy}>ثبت شمارش</PrimaryButton>
        </form>
      </section>

      <section className={`min-w-0 ${cardClass} p-5`}>
        <h2 className="mb-3 font-semibold">شمارش‌های اخیر</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          برای دیدن اقلام هر شمارش و ویرایش یا حذف آن، روی شمارش بزنید.
        </p>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {(counts ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setEditingId(c.id)}
                className="flex min-w-0 w-full flex-col gap-2 px-4 py-3 text-start text-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-400/40 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0 break-words font-medium">
                  {toPersianDigits(c.line_count)} قلم{" "}
                  {c.note ? `— ${c.note}` : ""}
                </span>
                <span className="text-xs text-muted-foreground">
                  {c.counted_by_name ?? ""} — {formatJalali(c.counted_at)}
                </span>
              </button>
            </li>
          ))}
          {counts && counts.length === 0 ? (
            <li className="p-3 text-sm text-muted-foreground">
              شمارشی ثبت نشده است.
            </li>
          ) : null}
        </ul>
      </section>

      {editingId ? (
        <StockCountModal
          countId={editingId}
          activeItems={activeItems}
          onClose={() => setEditingId(null)}
          onChanged={loadCounts}
        />
      ) : null}
    </div>
  );
}

function StockCountModal({
  countId,
  activeItems,
  onClose,
  onChanged,
}: {
  countId: string;
  activeItems: InventoryItem[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const money = useMoney();
  const [detail, setDetail] = useState<CountDetail | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [addQuery, setAddQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDetail(null);
    setError("");
    api<{ count: CountDetail }>(`/api/inventory/stock-counts/${countId}`).then(
      ({ ok, status, data }) => {
        if (ok) {
          setDetail(data.count);
          setNote(data.count.note ?? "");
          setDraft(
            Object.fromEntries(
              data.count.lines.map((l) => [l.inventoryItemId, l.countedQty]),
            ),
          );
        } else {
          setError(
            status === 404 ? "این شمارش پیدا نشد." : "خطا در دریافت شمارش.",
          );
        }
      },
    );
  }, [countId]);

  const deferredAddQuery = useDeferredValue(addQuery);
  const searchResults = useInventorySearch(activeItems, deferredAddQuery);
  const addableItems = useMemo(
    () => searchResults.filter((i) => !(i.id in draft)),
    [searchResults, draft],
  );

  const draftLines = useMemo(
    () => detail?.lines.filter((l) => l.inventoryItemId in draft) ?? [],
    [detail, draft],
  );
  const addedItemIds = useMemo(
    () =>
      Object.keys(draft).filter(
        (id) => !detail?.lines.some((l) => l.inventoryItemId === id),
      ),
    [draft, detail],
  );
  const itemById = useMemo(
    () => new Map(activeItems.map((i) => [i.id, i])),
    [activeItems],
  );

  async function save() {
    setBusy(true);
    setError("");
    const lines = Object.entries(draft)
      .filter(([, value]) => value.trim())
      .map(([inventoryItemId, countedQty]) => ({
        inventoryItemId,
        countedQty: countedQty.trim(),
      }));
    const { ok, data } = await api<{ error?: string }>(
      `/api/inventory/stock-counts/${countId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ note, lines }),
      },
    );
    setBusy(false);
    if (!ok) {
      setError(countError(data.error));
      return;
    }
    onChanged();
    onClose();
  }

  async function remove() {
    if (
      !window.confirm(
        "این شمارش به‌طور کامل حذف و اثر آن بر موجودی و حسابداری برگردانده شود؟",
      )
    )
      return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(
      `/api/inventory/stock-counts/${countId}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (!ok) {
      setError(countError(data.error));
      return;
    }
    onChanged();
    onClose();
  }

  function setQty(inventoryItemId: string, value: string) {
    setDraft((prev) => ({ ...prev, [inventoryItemId]: value }));
  }

  function dropLine(inventoryItemId: string) {
    setDraft((prev) => {
      const next = { ...prev };
      delete next[inventoryItemId];
      return next;
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="stock-count-modal-heading"
        className={`${overlayPanelClass} max-h-[88vh] w-full max-w-2xl overflow-y-auto p-4 sm:max-h-[80vh] sm:p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold text-amber-700">جزئیات شمارش</p>
            <h3
              id="stock-count-modal-heading"
              className="mt-1 text-lg font-bold"
            >
              {detail
                ? `${formatJalali(detail.countedAt)}${detail.countedByName ? ` — ${detail.countedByName}` : ""}`
                : "…"}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1 text-sm font-medium text-muted-foreground"
          >
            بستن
          </button>
        </header>

        {detail === null ? (
          <LoadingSkeleton rows={4} />
        ) : (
          <div className="space-y-4">
            {error ? (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            ) : null}

            <Field label="یادداشت">
              <input
                className={inputClass}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>

            <div>
              <p className="mb-2 text-sm font-medium">اقلام شمارش‌شده</p>
              {draftLines.length === 0 && addedItemIds.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border bg-stone-50 px-4 py-6 text-center text-sm text-muted-foreground">
                  قلمی باقی نمانده است؛ ذخیرهٔ این تغییرات یعنی حذف کامل شمارش.
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {draftLines.map((l) => (
                    <li
                      key={l.id}
                      className="flex flex-col gap-2 px-3 py-3 text-sm"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 break-words">
                          {l.itemName}{" "}
                          <span className="text-xs text-muted-foreground">
                            (موجودی سیستم: {formatQuantity(l.systemQty)}{" "}
                            {l.unit})
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => dropLine(l.inventoryItemId)}
                          className="rounded-md border border-border p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          aria-label={`حذف ${l.itemName} از شمارش`}
                        >
                          <XIcon className="size-4" aria-hidden="true" />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                        <label className="grid gap-1">
                          <span>مقدار شمارش‌شده</span>
                          <PersianNumberInput
                            className={inputClass}
                            dir="ltr"
                            inputMode="decimal"
                            value={draft[l.inventoryItemId] ?? ""}
                            onChange={(e) =>
                              setQty(l.inventoryItemId, e.target.value)
                            }
                          />
                        </label>
                        <span>
                          اختلاف:{" "}
                          <span className="font-medium text-foreground">
                            {formatQuantity(l.variance)}
                          </span>
                        </span>
                        {l.varianceValue !== "0" ? (
                          <span>
                            ارزش اختلاف:{" "}
                            <span className="font-medium text-foreground">
                              {money.formatText(l.varianceValue)}
                            </span>
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                  {addedItemIds.map((id) => {
                    const item = itemById.get(id);
                    if (!item) return null;
                    return (
                      <li
                        key={id}
                        className="flex flex-col gap-2 px-3 py-3 text-sm"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="min-w-0 break-words">
                            {item.name}{" "}
                            <span className="text-xs text-muted-foreground">
                              (موجودی سیستم: {formatQuantity(item.stock)}{" "}
                              {item.unit})
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={() => dropLine(id)}
                            className="rounded-md border border-border p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label={`حذف ${item.name} از شمارش`}
                          >
                            <XIcon className="size-4" aria-hidden="true" />
                          </button>
                        </div>
                        <label className="grid w-full gap-1 text-xs font-medium sm:w-40">
                          <span>مقدار شمارش‌شده</span>
                          <PersianNumberInput
                            className={inputClass}
                            dir="ltr"
                            inputMode="decimal"
                            value={draft[id] ?? ""}
                            onChange={(e) => setQty(id, e.target.value)}
                          />
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">افزودن قلم</p>
              <div className="relative mb-2">
                <SearchIcon
                  className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  className={`${inputClass} ps-9`}
                  value={addQuery}
                  onChange={(e) => setAddQuery(e.target.value)}
                  placeholder="نام یا کد قلم…"
                />
              </div>
              {addableItems.length > 0 ? (
                <ul className="max-h-40 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {addableItems.slice(0, 8).map((i) => (
                    <li key={i.id}>
                      <button
                        type="button"
                        onClick={() => setQty(i.id, "")}
                        className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-muted/40"
                      >
                        <PlusIcon
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 break-words">
                          {i.name}{" "}
                          <span className="text-xs text-muted-foreground">
                            ({formatQuantity(i.stock)} {i.unit})
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div className="flex flex-col gap-2 pt-1 sm:flex-row">
              <PrimaryButton onClick={save} disabled={busy} type="button">
                {busy ? "در حال ذخیره…" : "ذخیره تغییرات"}
              </PrimaryButton>
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="rounded-xl border border-destructive/40 px-5 py-2.5 font-semibold text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
              >
                حذف شمارش
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
