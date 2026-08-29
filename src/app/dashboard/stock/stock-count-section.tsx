"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useRef, useState } from "react";
import Decimal from "decimal.js";
import { Button } from "@/components/ui/button";
import { CameraScanTrigger } from "@/components/scanner/camera-barcode-scanner";
import { formatPersianNumber, formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { EmptyState, SectionCard } from "../page-chrome";
import { api, Field, inputClass } from "../ui";

/**
 * Physical stock count (انبارگردانی) for the retail item model.
 *
 * Scan-driven, for the same reason the F&B count screen is: a shop with
 * thousands of lines cannot be counted by finding each item in a dropdown. The
 * scan resolves through `/api/barcodes/lookup`, which Phase 27 Wave 4 already
 * built for the sell screen — this screen adds no new lookup path, it just
 * counts what the scan names instead of selling it.
 *
 * The input is deliberately never disabled while a lookup is in flight: a
 * handheld scanner is a keyboard and will type the next code regardless, and a
 * disabled field silently swallows it.
 */
export interface CountableItem {
  id: string;
  name: string;
  quantity: string;
}

interface CountSummary {
  id: string;
  note: string | null;
  countedAt: string;
  countedByName: string | null;
  lineCount: number;
  shortageValue: string;
  surplusValue: string;
  reversed: boolean;
}

function countError(code: string | undefined, message?: string): string {
  const map: Record<string, string> = {
    no_items: "هیچ قلمی برای شمارش وارد نشده است.",
    invalid_quantity: "مقدار شمارش‌شده باید عددی مثبت باشد.",
    duplicate_item: "یک قلم دو بار در فهرست آمده است.",
    item_not_found: "این کالا در این شعبه یافت نشد.",
    count_not_found: "این انبارگردانی پیدا نشد.",
    count_not_reversible: "این ردیف خودش یک برگشت است و قابل برگشت نیست.",
    already_reversed: "این انبارگردانی قبلاً برگشت خورده است.",
    count_stock_consumed:
      "کالای اضافهٔ این انبارگردانی بعداً فروخته شده و قابل برگشت نیست؛ یک انبارگردانی تازه ثبت کنید.",
    ledger_account_missing: "حساب مورد نیاز در دفتر حساب‌ها موجود نیست.",
  };
  return map[code ?? ""] ?? message ?? "عملیات ناموفق بود.";
}

export function StockCountSection({
  items,
  onDone,
  onError,
  reload,
}: {
  items: CountableItem[];
  onDone: (message: string) => void;
  onError: (message: string) => void;
  reload: () => void;
}) {
  const money = useMoney();
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [code, setCode] = useState("");
  const [qtyPerScan, setQtyPerScan] = useState("1");
  const [scanFeedback, setScanFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [manualId, setManualId] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<CountSummary[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadHistory = useCallback(() => {
    api<{ counts: CountSummary[] }>("/api/stock/counts").then(({ ok, data }) => {
      if (ok) setHistory(data.counts);
    });
  }, []);
  useEffect(loadHistory, [loadHistory]);

  const addToTally = useCallback((itemId: string, step: number, itemName: string) => {
    setOrder((prev) => (prev.includes(itemId) ? prev : [itemId, ...prev]));
    setCounted((prev) => {
      const current = prev[itemId]?.trim();
      const base = current && Number.isFinite(Number(current)) ? new Decimal(current) : new Decimal(0);
      const next = base.plus(step);
      setScanFeedback({
        kind: "ok",
        text: `${itemName} — شمارش‌شده: ${formatQuantity(next.toFixed())}`,
      });
      return { ...prev, [itemId]: next.toFixed() };
    });
  }, []);

  async function resolveScan(raw: string) {
    const needle = raw.trim();
    if (!needle) return;
    setCode("");
    inputRef.current?.focus();

    const step = Number(qtyPerScan);
    if (!Number.isFinite(step) || step <= 0) {
      setScanFeedback({ kind: "error", text: "مقدار هر اسکن باید عددی مثبت باشد." });
      return;
    }

    const { ok, data } = await api<{
      matches?: { itemId: string; itemName: string }[];
      message?: string;
    }>(`/api/barcodes/lookup?code=${encodeURIComponent(needle)}`);
    if (!ok) {
      setScanFeedback({ kind: "error", text: data.message ?? "بارکد خوانده نشد." });
      return;
    }
    const matches = data.matches ?? [];
    if (matches.length === 0) {
      setScanFeedback({
        kind: "error",
        text: `بارکد ${toPersianDigits(needle)} به هیچ کالایی متصل نیست.`,
      });
      return;
    }
    if (matches.length > 1) {
      setScanFeedback({ kind: "error", text: "این بارکد به بیش از یک کالا اشاره دارد." });
      return;
    }
    const match = matches[0];
    if (!items.some((i) => i.id === match.itemId)) {
      setScanFeedback({
        kind: "error",
        text: `«${match.itemName}» در انبار این شعبه نیست.`,
      });
      return;
    }
    addToTally(match.itemId, step, match.itemName);
  }

  async function submit() {
    const lines = order
      .filter((id) => counted[id]?.trim())
      .map((id) => ({ itemId: id, countedQty: counted[id].trim() }));
    if (lines.length === 0) return;

    setBusy(true);
    const { ok, data } = await api<{ error?: string; message?: string; shortage?: string; surplus?: string }>(
      "/api/stock/counts",
      { method: "POST", body: JSON.stringify({ note, lines }) },
    );
    setBusy(false);
    if (!ok) {
      onError(countError(data.error, data.message));
      return;
    }
    setCounted({});
    setOrder([]);
    setNote("");
    setScanFeedback(null);
    onDone(
      `انبارگردانی ثبت شد — کسری ${money.format(Number(data.shortage ?? 0))}، اضافه ${money.format(
        Number(data.surplus ?? 0),
      )}.`,
    );
    loadHistory();
    reload();
  }

  async function reverse(id: string) {
    setBusy(true);
    const { ok, data } = await api<{ error?: string; message?: string }>(`/api/stock/counts/${id}/reverse`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    setBusy(false);
    if (!ok) {
      onError(countError(data.error, data.message));
      return;
    }
    onDone("انبارگردانی برگشت خورد.");
    loadHistory();
    reload();
  }

  const tally = order
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is CountableItem => Boolean(i));

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <SectionCard
        title="انبارگردانی"
        description="بارکد هر کالا را اسکن کنید؛ مقدار شمارش‌شده جمع می‌شود. پس از ثبت، موجودی سیستم برابر مقدار شمارش‌شده می‌شود و اختلاف به‌عنوان کسری یا اضافهٔ انبارگردانی در دفتر ثبت می‌گردد."
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem_auto]">
          <Field label="بارکد">
            <input
              ref={inputRef}
              className={inputClass}
              dir="ltr"
              value={code}
              autoFocus
              placeholder="اسکن بارکد…"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void resolveScan(code);
                }
              }}
            />
          </Field>
          <Field label="مقدار هر اسکن">
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="decimal"
              value={qtyPerScan}
              onChange={(e) => setQtyPerScan(e.target.value)}
            />
          </Field>
          <div className="mb-4 flex items-end">
            <CameraScanTrigger
              label="دوربین"
              title="اسکن بارکد انبارگردانی"
              description="بارکد کالا را با دوربین موبایل بخوانید تا به شمارش افزوده شود."
              onScan={(scanned) => void resolveScan(scanned)}
            />
          </div>
        </div>
        {scanFeedback ? (
          <p
            className={`mt-2 text-xs leading-5 ${
              scanFeedback.kind === "ok" ? "text-emerald-700" : "text-rose-700"
            }`}
            role="status"
            aria-live="polite"
          >
            {scanFeedback.text}
          </p>
        ) : null}

        <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
          <select
            className={inputClass}
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
          >
            <option value="">افزودن دستی کالا…</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            disabled={busy || !manualId}
            className="min-h-11"
            onClick={() => {
              const item = items.find((i) => i.id === manualId);
              if (item) addToTally(item.id, 0, item.name);
              setManualId("");
            }}
          >
            افزودن
          </Button>
        </div>

        {tally.length > 0 ? (
          <ul className="mt-3 divide-y divide-stone-200/80 text-sm">
            {tally.map((i) => {
              const value = counted[i.id]?.trim();
              const variance =
                value && Number.isFinite(Number(value))
                  ? new Decimal(value).minus(i.quantity)
                  : null;
              return (
                <li key={i.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0 break-words">
                    <span className="font-medium text-stone-950">{i.name}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      (سیستم: {formatQuantity(i.quantity)})
                    </span>
                    {variance && !variance.isZero() ? (
                      <span
                        className={`ms-2 text-xs ${
                          variance.isNegative() ? "text-rose-700" : "text-emerald-700"
                        }`}
                      >
                        {variance.isNegative() ? "کسری" : "اضافه"}{" "}
                        {formatQuantity(variance.abs().toFixed())}
                      </span>
                    ) : null}
                  </span>
                  <PersianNumberInput
                    className={`${inputClass} w-full sm:w-32`}
                    dir="ltr"
                    inputMode="decimal"
                    value={counted[i.id] ?? ""}
                    onChange={(e) =>
                      setCounted((prev) => ({ ...prev, [i.id]: e.target.value }))
                    }
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState>هنوز کالایی شمارش نشده است.</EmptyState>
        )}

        <div className="mt-3">
          <Field label="یادداشت">
            <input
              className={inputClass}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="اختیاری"
            />
          </Field>
        </div>
        <Button
          type="button"
          disabled={busy || tally.length === 0}
          className="mt-3 min-h-11 w-full"
          onClick={() => void submit()}
        >
          ثبت انبارگردانی
        </Button>
      </SectionCard>

      <SectionCard
        title="انبارگردانی‌های اخیر"
        description="یک انبارگردانی ثبت‌شده ویرایش نمی‌شود؛ برای اصلاح، آن را برگشت بزنید و شمارش تازه ثبت کنید."
      >
        {history.length === 0 ? (
          <EmptyState>انبارگردانی ثبت نشده است.</EmptyState>
        ) : (
          <ul className="mt-3 divide-y divide-stone-200/80 text-sm">
            {history.map((c) => (
              <li key={c.id} className="flex flex-col gap-1 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-stone-950">
                    {formatPersianNumber(c.lineCount)} قلم {c.note ? `— ${c.note}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatJalali(c.countedAt)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs">
                    <span className="text-rose-700">کسری {money.format(Number(c.shortageValue))}</span>
                    {" · "}
                    <span className="text-emerald-700">اضافه {money.format(Number(c.surplusValue))}</span>
                  </span>
                  {c.reversed ? (
                    <span className="text-xs text-muted-foreground">برگشت‌خورده</span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void reverse(c.id)}
                    >
                      برگشت
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
