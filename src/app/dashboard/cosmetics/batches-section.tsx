"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatToman } from "@/lib/money";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, Field, inputClass } from "../ui";

const accInputClass = `${inputClass} min-h-[52px] !border-stone-200 !bg-white shadow-none placeholder:text-stone-400 focus-visible:border-amber-500 focus-visible:ring-amber-400/30`;

interface BatchItem {
  id: string;
  name: string;
  parentName: string | null;
  tracking: string;
  batches: { id: string; batchNumber: string; expiryDate: string | null; quantity: string }[];
}

interface NearExpiryRow {
  itemId: string;
  itemName: string;
  batchNumber: string;
  expiryDate: string | null;
  quantity: string;
  bucket: "expired" | "under30" | "under90";
}

const BUCKET_LABELS: Record<NearExpiryRow["bucket"], string> = {
  expired: "منقضی",
  under30: "زیر ۳۰ روز",
  under90: "زیر ۹۰ روز",
};

export function BatchesSection() {
  const [items, setItems] = useState<BatchItem[]>([]);
  const [nearExpiry, setNearExpiry] = useState<NearExpiryRow[]>([]);
  const [itemId, setItemId] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(() => {
    api<{ items: BatchItem[] }>("/api/cosmetics/items").then(({ ok, data }) => {
      if (ok) setItems(data.items.filter((i) => i.tracking === "batch"));
    });
    api<{ rows: NearExpiryRow[] }>("/api/cosmetics/reports/near-expiry").then(({ ok, data }) => {
      if (ok) setNearExpiry(data.rows);
    });
  }, []);
  useEffect(load, [load]);

  const batchItems = items.filter((i) => i.tracking === "batch");

  async function receive(e: React.FormEvent) {
    e.preventDefault();
    if (!itemId || !batchNumber.trim()) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(`/api/cosmetics/items/${itemId}/batches`, {
      method: "POST",
      body: JSON.stringify({
        batchNumber: batchNumber.trim(),
        expiryDate: expiryDate.trim() || null,
        quantity: quantity.trim() || "0",
        unitCost: Number(unitCost || 0),
      }),
    });
    setBusy(false);
    if (!ok) {
      setError(data.message ?? "ثبت بچ ناموفق بود.");
      return;
    }
    setDone("بچ ثبت شد.");
    setBatchNumber("");
    setExpiryDate("");
    setQuantity("");
    setUnitCost("");
    load();
  }

  async function writeOff(itemIdToWriteOff: string) {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(
      `/api/cosmetics/items/${itemIdToWriteOff}/expired-write-off`,
      {
        method: "POST",
      },
    );
    setBusy(false);
    if (!ok) {
      setError(data.message ?? "حذف بچ منقضی ناموفق بود.");
      return;
    }
    setDone("بچ منقضی از موجودی حذف و در حساب ۵۱۶۰ ثبت شد.");
    load();
  }

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <section className="min-w-0 overflow-hidden rounded-2xl bg-card">
        <div className="border-b border-stone-200/80 px-4 py-4 sm:px-5">
          <h2 className="font-semibold text-stone-950">بچ‌های نزدیک به انقضا</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            بچ‌های منقضی قابل فروش نیستند و با یک کلیک از موجودی حذف می‌شوند.
          </p>
        </div>
        <ul className="divide-y divide-stone-200/80">
          {nearExpiry.map((row) => (
            <li key={`${row.itemId}-${row.batchNumber}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <span className="font-medium text-stone-950">{row.itemName}</span>
                <span className="mr-2 text-xs text-muted-foreground">
                  بچ {row.batchNumber} · {formatQuantity(row.quantity)} عدد
                  {row.expiryDate ? ` · انقضا ${toPersianDigits(formatJalali(row.expiryDate))}` : ""}
                </span>
                <span
                  className={`ms-2 rounded-full px-2 py-0.5 text-xs font-medium ${
                    row.bucket === "expired"
                      ? "bg-rose-100 text-rose-800"
                      : row.bucket === "under30"
                        ? "bg-amber-100 text-amber-900"
                        : "bg-stone-100 text-stone-700"
                  }`}
                >
                  {BUCKET_LABELS[row.bucket]}
                </span>
              </div>
              {row.bucket === "expired" ? (
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => writeOff(row.itemId)}>
                  حذف از موجودی
                </Button>
              ) : null}
            </li>
          ))}
          {nearExpiry.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">بچی نزدیک به انقضا نیست.</li>
          ) : null}
        </ul>
      </section>

      <aside className="min-w-0">
        <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.035)] sm:p-5">
          <h2 className="font-semibold text-stone-950">ورود بچ</h2>
          <form onSubmit={receive} className="mt-4 space-y-3">
            <Field label="کالا">
              <SearchableSelect
                className={accInputClass}
                value={itemId}
                onChange={setItemId}
                options={batchItems.map((i) => ({
                  value: i.id,
                  label: `${i.parentName ? `${i.parentName} — ` : ""}${i.name}`,
                }))}
                placeholder="انتخاب کالای بچ‌محور"
              />
            </Field>
            <Field label="شماره بچ">
              <input className={accInputClass} value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} dir="ltr" />
            </Field>
            <Field label="تاریخ انقضا">
              <input className={accInputClass} type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} dir="ltr" />
            </Field>
            <Field label="تعداد">
              <input className={accInputClass} value={quantity} onChange={(e) => setQuantity(e.target.value)} dir="ltr" inputMode="decimal" />
            </Field>
            <Field label="بهای تمام‌شده هر واحد (ریال)">
              <input className={accInputClass} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} dir="ltr" inputMode="numeric" />
            </Field>
            {error ? <p className="text-xs text-rose-700">{error}</p> : null}
            {done ? <p className="text-xs text-emerald-700">{done}</p> : null}
            <Button type="submit" disabled={busy} size="lg" className="min-h-[52px] w-full border border-amber-300 px-5 font-semibold">
              ثبت بچ
            </Button>
          </form>
        </div>
      </aside>
    </div>
  );
}
