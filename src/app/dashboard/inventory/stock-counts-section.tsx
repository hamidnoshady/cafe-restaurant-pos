"use client";

import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { api, inputClass, PrimaryButton } from "../ui";
import type { InventoryItem, Runner } from "./inventory-manager";

interface StockCount {
  id: string;
  note: string | null;
  counted_at: string;
  counted_by_name: string | null;
  line_count: string | number;
}

export function StockCountsSection({ items, busy, run }: { items: InventoryItem[]; busy: boolean; run: Runner }) {
  const [counts, setCounts] = useState<StockCount[] | null>(null);
  const [note, setNote] = useState("");
  const [countedQty, setCountedQty] = useState<Record<string, string>>({});

  const loadCounts = useCallback(() => {
    api<{ counts: StockCount[] }>("/api/inventory/stock-counts").then(({ ok, data }) => {
      if (ok) setCounts(data.counts);
    });
  }, []);
  useEffect(loadCounts, [loadCounts]);

  const activeItems = items.filter((i) => i.is_active);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const lines = activeItems
      .filter((i) => countedQty[i.id]?.trim())
      // Text, not Number: the count is costed in exact decimal server-side.
      .map((i) => ({ inventoryItemId: i.id, countedQty: countedQty[i.id].trim() }));
    if (lines.length === 0) return;

    const ok = await run(() =>
      api("/api/inventory/stock-counts", { method: "POST", body: JSON.stringify({ note, lines }) }),
    );
    if (ok) {
      setNote("");
      setCountedQty({});
      loadCounts();
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">شمارش فیزیکی انبار</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          فقط اقلامی که مقدار شمارش‌شده برایشان وارد شود ثبت می‌شوند؛ اختلاف با موجودی سیستم به‌صورت خودکار به‌عنوان اصلاحیه ثبت می‌شود.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="یادداشت (اختیاری)" />
          <ul className="divide-y divide-border rounded-lg border border-border">
            {activeItems.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  {i.name} <span className="text-xs text-muted-foreground">(موجودی سیستم: {toPersianDigits(i.stock)} {i.unit})</span>
                </span>
                <input
                  className={`${inputClass} w-32`}
                  dir="ltr"
                  inputMode="decimal"
                  value={countedQty[i.id] ?? ""}
                  onChange={(e) => setCountedQty((prev) => ({ ...prev, [i.id]: e.target.value }))}
                  placeholder="مقدار شمارش‌شده"
                />
              </li>
            ))}
          </ul>
          <PrimaryButton disabled={busy}>ثبت شمارش</PrimaryButton>
        </form>
      </section>

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">شمارش‌های اخیر</h2>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {(counts ?? []).map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
              <span>
                {toPersianDigits(c.line_count)} قلم {c.note ? `— ${c.note}` : ""}
              </span>
              <span className="text-xs text-muted-foreground">
                {c.counted_by_name ?? ""} — {formatJalali(c.counted_at)}
              </span>
            </li>
          ))}
          {counts && counts.length === 0 ? <li className="p-3 text-sm text-muted-foreground">شمارشی ثبت نشده است.</li> : null}
        </ul>
      </section>
    </div>
  );
}
