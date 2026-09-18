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
import { api, errorMessage, Field, inputClass } from "../ui";
import { Button } from "@/components/ui/button";
import { CountScanField, type ScanMatch } from "./count-scan-field";
import { VisionCountPanel } from "./vision-count-panel";
import type { InventoryItem, Runner } from "./inventory-manager";
import { overlayPanelClass, SectionCard, EmptyState, StatusBadge } from "../page-chrome";

interface StockCount {
  id: string;
  note: string | null;
  counted_at: string;
  counted_by_name: string | null;
  line_count: string | number;
  shortage_value: string;
  surplus_value: string;
  /** A reversal remains in the audit trail but cannot be edited again. */
  reversed: boolean;
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
  reversed: boolean;
  lines: CountLine[];
}

function countError(code: string | undefined): string {
  const map: Record<string, string> = {
    no_items: "حداقل یک قلم را برای شمارش وارد کنید.",
    invalid_item: "یکی از اقلام انتخاب‌شده معتبر نیست.",
    invalid_quantity: "مقدار شمارش‌شده باید صفر یا یک عدد مثبت باشد.",
    quantity_precision_exceeded: "مقدار شمارش‌شده بیش از ۹ رقم اعشار دارد.",
    duplicate_item: "یک قلم دوبار در فهرست شمارش آمده است.",
    item_not_found: "یکی از اقلام در این شعبه پیدا نشد.",
    ledger_account_missing: "حساب مورد نیاز در دفتر حساب‌ها موجود نیست.",
    periodic_system_unsupported: "در سیستم ادواری، شمارش باید از «بستن دوره» انجام شود.",
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
  const money = useMoney();
  const [counts, setCounts] = useState<StockCount[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [note, setNote] = useState("");
  const [countedQty, setCountedQty] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Items reached by the scanner or the camera counter this session, newest
   *  first — pinned above the full list so a warehouse of thousands stays
   *  legible while counting. */
  const [scannedIds, setScannedIds] = useState<string[]>([]);
  /** Which of the session items were reached by the camera counter — drives
   *  the row's source chip («دوربین») next to the scanner-reached ones. */
  const [cameraCountedIds, setCameraCountedIds] = useState<Set<string>>(new Set());
  const countedQtyRef = useRef<Record<string, string>>({});

  const loadCounts = useCallback(() => {
    setLoadError("");
    api<{ counts: StockCount[]; error?: string }>("/api/inventory/stock-counts")
      .then(({ ok, data }) => {
        if (ok) setCounts(data.counts);
        else setLoadError(errorMessage(data.error));
      })
      .catch(() => setLoadError("دریافت سوابق شمارش ناموفق بود؛ دوباره تلاش کنید."));
  }, []);
  useEffect(loadCounts, [loadCounts]);

  const activeItems = useMemo(() => items.filter((i) => i.is_active), [items]);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const visibleItems = useInventorySearch(activeItems, deferredSearchQuery);
  // Avoid mounting thousands of editable inputs on a phone. Search narrows the
  // catalogue first; the cap is only a rendering guard, never a submission
  // limit (scanned and already-entered lines remain in the tally).
  const renderedItems = visibleItems.slice(0, 200);

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

  /** A confirmed visual count lands in the same tally as a scan: add by
   *  default, replace when the operator re-counted a shelf they had already
   *  partly scanned. Same Decimal discipline as handleScan. */
  const handleVisionApply = useCallback(
    (inventoryItemId: string, qty: string, mode: "add" | "replace") => {
      const value = new Decimal(qty);
      setScannedIds((prev) =>
        prev.includes(inventoryItemId) ? prev : [inventoryItemId, ...prev],
      );
      setCameraCountedIds((prev) => new Set(prev).add(inventoryItemId));
      setCountedQty((prev) => {
        if (mode === "replace") return { ...prev, [inventoryItemId]: value.toFixed() };
        const current = prev[inventoryItemId]?.trim();
        const base =
          current && Number.isFinite(Number(current)) ? new Decimal(current) : new Decimal(0);
        return { ...prev, [inventoryItemId]: base.plus(value).toFixed() };
      });
    },
    [],
  );

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

  /** How many items currently carry a count — drives the submit summary. */
  const tallyLines = useMemo(
    () => activeItems.filter((i) => countedQty[i.id]?.trim()).length,
    [activeItems, countedQty],
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
      setCameraCountedIds(new Set());
      loadCounts();
    }
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">عملیات شمارش</p>
            <h2 className="mt-1 font-semibold text-foreground">شمارش فیزیکی انبار</h2>
          </div>
        }
        description="فقط اقلامی که مقدار شمارش‌شده برایشان وارد شود ثبت می‌شوند؛ اختلاف با موجودی سیستم به‌صورت خودکار به‌عنوان اصلاحیه ثبت می‌شود."
      >
        <form onSubmit={submit} className="space-y-3">
          <CountScanField
            onScan={handleScan}
            isCountable={isCountable}
            runningTotal={runningTotal}
          />
          {scannedItems.length > 0 ? (
            <div className="rounded-lg border border-border">
              <div className="flex items-center justify-between px-3 py-2 text-xs font-medium">
                <span>شمارش‌شده در این نشست ({toPersianDigits(scannedItems.length)})</span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    setScannedIds([]);
                    setCameraCountedIds(new Set());
                    setCountedQty((prev) => {
                      const next = { ...prev };
                      for (const id of scannedIds) delete next[id];
                      return next;
                    });
                  }}
                >
                  پاک کردن شمارش‌های این نشست
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
                      {cameraCountedIds.has(i.id) ? (
                        <StatusBadge tone="active">دوربین</StatusBadge>
                      ) : null}{" "}
                      <span className="text-xs text-muted-foreground">
                        (موجودی سیستم: {formatQuantity(i.stock)} {i.unit})
                      </span>
                    </span>
                    <div className="flex min-w-0 items-end gap-1.5">
                      <button
                        type="button"
                        className="flex min-h-[3.25rem] min-w-11 items-center justify-center rounded-lg border border-border px-3 text-base font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                        onClick={() =>
                          setCountedQty((prev) => {
                            const current = prev[i.id]?.trim();
                            const base =
                              current && Number.isFinite(Number(current))
                                ? new Decimal(current)
                                : new Decimal(0);
                            return { ...prev, [i.id]: Decimal.max(base.minus(1), 0).toFixed() };
                          })
                        }
                        aria-label={`کم کردن یک واحد از شمارش ${i.name}`}
                      >
                        −
                      </button>
                      <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium sm:w-36 sm:flex-none">
                        <span>مقدار شمارش‌شده</span>
                        <PersianNumberInput
                          className={inputClass}
                          dir="ltr"
                          inputMode="decimal"
                          allowNegative={false}
                          value={countedQty[i.id] ?? ""}
                          onChange={(e) =>
                            setCountedQty((prev) => ({ ...prev, [i.id]: e.target.value }))
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="flex min-h-[3.25rem] min-w-11 items-center justify-center rounded-lg border border-border px-3 text-base font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                        onClick={() =>
                          setCountedQty((prev) => {
                            const current = prev[i.id]?.trim();
                            const base =
                              current && Number.isFinite(Number(current))
                                ? new Decimal(current)
                                : new Decimal(0);
                            return { ...prev, [i.id]: base.plus(1).toFixed() };
                          })
                        }
                        aria-label={`اضافه کردن یک واحد به شمارش ${i.name}`}
                      >
                        +
                      </button>
                    </div>
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
            {renderedItems.map((i) => (
              <li
                key={i.id}
                className="flex min-w-0 flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0 break-words">
                  {i.name}{" "}
                  {countedQty[i.id]?.trim() ? (
                    <StatusBadge tone="active">
                      شمارش‌شده: {formatQuantity(countedQty[i.id])}
                    </StatusBadge>
                  ) : null}{" "}
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
                    allowNegative={false}
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
          {visibleItems.length > renderedItems.length ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              {toPersianDigits(String(visibleItems.length - renderedItems.length))} قلم دیگر پیدا شد؛ جستجو را دقیق‌تر کنید تا ویرایش آن‌ها سریع بماند.
            </p>
          ) : null}
          {visibleItems.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              {searchQuery.trim()
                ? "قلمی با این جستجو یافت نشد."
                : "قلم فعالی برای شمارش موجود نیست."}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {tallyLines > 0
                ? `${toPersianDigits(tallyLines)} قلم آمادهٔ ثبت است.`
                : "هنوز قلمی شمارش نشده است."}
            </p>
            <Button
              type="submit"
              size="lg"
              className="flex-1 px-5 font-semibold sm:flex-none"
              disabled={busy || tallyLines === 0}
            >
              ثبت شمارش
            </Button>
          </div>
        </form>
      </SectionCard>

      <VisionCountPanel items={activeItems} run={run} onApply={handleVisionApply} />

      {loadError ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={loadCounts}>
            تلاش دوباره
          </Button>
        </div>
      ) : null}
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق شمارش</p>
            <h2 className="mt-1 font-semibold text-foreground">شمارش‌های اخیر</h2>
          </div>
        }
        description="برای دیدن اقلام هر شمارش روی آن بزنید؛ شمارش برگشت‌نخورده را می‌توانید اصلاح یا حذف کنید."
        flush
      >
        <ul className="divide-y divide-border/80">
          {counts === null ? (
            <li className="p-3">
              <LoadingSkeleton rows={3} />
            </li>
          ) : (
            counts.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setEditingId(c.id)}
                  className="flex min-w-0 w-full flex-col gap-2 px-4 py-3 text-start text-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0 break-words font-medium">
                    {toPersianDigits(c.line_count)} قلم{" "}
                    {c.note ? `— ${c.note}` : ""}
                    {c.reversed ? <StatusBadge tone="neutral">برگشت‌خورده</StatusBadge> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <span className="block sm:inline">
                      {c.counted_by_name ?? ""} — {formatJalali(c.counted_at)}
                    </span>
                    <span className="mt-1 block sm:ms-2 sm:mt-0 sm:inline">
                      کسری {money.formatText(c.shortage_value)} · اضافه {money.formatText(c.surplus_value)}
                    </span>
                  </span>
                </button>
              </li>
            ))
          )}
          {counts?.length === 0 ? (
            <li className="p-3">
              <EmptyState>هنوز شمارشی ثبت نشده است؛ با اسکنر، دوربین یا ورود دستی شروع کنید.</EmptyState>
            </li>
          ) : null}
        </ul>
      </SectionCard>

      {editingId ? (
        <StockCountModal
          countId={editingId}
          reversed={counts?.find((count) => count.id === editingId)?.reversed ?? false}
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
  reversed,
  activeItems,
  onClose,
  onChanged,
}: {
  countId: string;
  reversed: boolean;
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
    api<{ count: CountDetail }>(`/api/inventory/stock-counts/${countId}`)
      .then(({ ok, status, data }) => {
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
      })
      .catch(() => setError("دریافت جزئیات شمارش ناموفق بود؛ دوباره تلاش کنید."));
  }, [countId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
  const isReadOnly = reversed || Boolean(detail?.reversed);

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
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">جزئیات شمارش</p>
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
            className="min-h-11 rounded-lg border border-border px-3 py-1 text-sm font-medium text-muted-foreground"
          >
            بستن
          </button>
        </header>

        {detail === null ? (
          error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : (
            <LoadingSkeleton rows={4} />
          )
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
            {isReadOnly ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                این شمارش قبلاً برگشت خورده است و فقط برای مشاهده نمایش داده می‌شود.
              </p>
            ) : null}

            <Field label="یادداشت">
              <input
                className={inputClass}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="اختیاری"
                disabled={isReadOnly || busy}
              />
            </Field>

            <div>
              <p className="mb-2 text-sm font-medium">اقلام شمارش‌شده</p>
              {draftLines.length === 0 && addedItemIds.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border bg-muted px-4 py-6 text-center text-sm text-muted-foreground">
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
                          disabled={isReadOnly || busy}
                          className="rounded-lg border border-border p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
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
                            allowNegative={false}
                            disabled={isReadOnly || busy}
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
                            disabled={isReadOnly || busy}
                            className="rounded-lg border border-border p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
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
                            allowNegative={false}
                            disabled={isReadOnly || busy}
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
                  disabled={isReadOnly || busy}
                />
              </div>
              {addableItems.length > 0 ? (
                <ul className="max-h-40 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {addableItems.slice(0, 8).map((i) => (
                    <li key={i.id}>
                      <button
                        type="button"
                        onClick={() => setQty(i.id, "")}
                        disabled={isReadOnly || busy}
                        className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-muted/40 disabled:opacity-50"
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
              <Button type="button" size="lg" className="w-full px-5 font-semibold" onClick={save} disabled={busy || isReadOnly}>
                {busy ? "در حال ذخیره…" : "ذخیره تغییرات"}
              </Button>
              <button
                type="button"
                onClick={remove}
                disabled={busy || isReadOnly}
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
