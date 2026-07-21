"use client";

import { useCallback, useEffect, useState } from "react";
import { formatToman, parseToRial } from "@/lib/money";
import { formatJalali } from "@/lib/jalali";
import { api, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import type { InventoryItem, Runner, Supplier } from "./inventory-manager";

interface Purchase {
  id: string;
  status: "draft" | "ordered" | "received" | "cancelled";
  total: string | number;
  note: string | null;
  supplier_name: string | null;
  created_at: string;
}

interface DraftLine {
  inventoryItemId: string;
  purchaseQty: string;
  totalCost: string;
}

const STATUS_LABELS: Record<Purchase["status"], string> = {
  draft: "پیش‌نویس",
  ordered: "سفارش داده‌شده",
  received: "دریافت‌شده",
  cancelled: "لغوشده",
};

const SETTLEMENT_LABELS: Record<string, string> = {
  credit: "نسیه (حساب‌های پرداختنی)",
  cash: "نقدی (صندوق)",
  bank: "بانک/کارت‌خوان",
};

export function PurchasesSection({
  items,
  suppliers,
  busy,
  run,
}: {
  items: InventoryItem[];
  suppliers: Supplier[];
  busy: boolean;
  run: Runner;
}) {
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ inventoryItemId: "", purchaseQty: "", totalCost: "" }]);
  const [settlementByPurchase, setSettlementByPurchase] = useState<Record<string, string>>({});

  const loadPurchases = useCallback(() => {
    api<{ purchases: Purchase[] }>("/api/inventory/purchases").then(({ ok, data }) => {
      if (ok) setPurchases(data.purchases);
    });
  }, []);
  useEffect(loadPurchases, [loadPurchases]);

  const activeItems = items.filter((i) => i.is_active);

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, { inventoryItemId: "", purchaseQty: "", totalCost: "" }]);
  }
  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const payloadLines = lines
      .filter((l) => l.inventoryItemId && l.purchaseQty.trim())
      .map((l) => {
        let totalCostRial: number;
        try {
          totalCostRial = parseToRial(l.totalCost || "0", "toman");
        } catch {
          totalCostRial = NaN;
        }
        return { inventoryItemId: l.inventoryItemId, purchaseQty: Number(l.purchaseQty), totalCost: totalCostRial };
      });
    if (payloadLines.length === 0) return;

    const ok = await run(() =>
      api("/api/inventory/purchases", {
        method: "POST",
        body: JSON.stringify({ supplierId: supplierId || null, note, items: payloadLines }),
      }),
    );
    if (ok) {
      setNote("");
      setLines([{ inventoryItemId: "", purchaseQty: "", totalCost: "" }]);
      loadPurchases();
    }
  }

  async function transition(id: string, status: string, settlementMethod?: string) {
    const ok = await run(() =>
      api(`/api/inventory/purchases/${id}`, { method: "PATCH", body: JSON.stringify({ status, settlementMethod }) }),
    );
    if (ok) loadPurchases();
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">ثبت خرید (رسید ورود کالا)</h2>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <select className={inputClass} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">بدون تأمین‌کننده</option>
              {suppliers.filter((s) => s.is_active).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="یادداشت (اختیاری)" />
          </div>

          <div className="space-y-2">
            {lines.map((line, i) => {
              const invItem = items.find((it) => it.id === line.inventoryItemId);
              return (
                <div key={i} className="grid gap-2 sm:grid-cols-5">
                  <select
                    className={inputClass}
                    value={line.inventoryItemId}
                    onChange={(e) => updateLine(i, { inventoryItemId: e.target.value })}
                  >
                    <option value="">قلم انبار…</option>
                    {activeItems.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className={inputClass}
                    dir="ltr"
                    inputMode="decimal"
                    value={line.purchaseQty}
                    onChange={(e) => updateLine(i, { purchaseQty: e.target.value })}
                    placeholder={`مقدار (${invItem?.purchase_unit || invItem?.unit || "واحد"})`}
                  />
                  <input
                    className={inputClass}
                    dir="ltr"
                    inputMode="numeric"
                    value={line.totalCost}
                    onChange={(e) => updateLine(i, { totalCost: e.target.value })}
                    placeholder="مبلغ کل (تومان)"
                  />
                  <span className="self-center text-xs text-stone-400">
                    {invItem?.purchase_unit ? `= ${invItem.purchase_unit_factor} ${invItem.unit} به ازای هر واحد خرید` : null}
                  </span>
                  <SecondaryButton onClick={() => removeLine(i)} disabled={lines.length === 1}>
                    حذف ردیف
                  </SecondaryButton>
                </div>
              );
            })}
          </div>
          <div className="flex gap-2">
            <SecondaryButton onClick={addLine}>افزودن ردیف</SecondaryButton>
            <PrimaryButton disabled={busy}>ثبت پیش‌نویس خرید</PrimaryButton>
          </div>
        </form>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">خریدهای اخیر</h2>
        <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
          {(purchases ?? []).map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
              <span>
                {p.supplier_name ?? "بدون تأمین‌کننده"} — {formatToman(Number(p.total))} —{" "}
                <span className="text-xs text-stone-400">{formatJalali(p.created_at)}</span>
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs">{STATUS_LABELS[p.status]}</span>
                {p.status === "draft" || p.status === "ordered" ? (
                  <>
                    {p.status === "draft" ? (
                      <SecondaryButton disabled={busy} onClick={() => transition(p.id, "ordered")}>
                        ثبت سفارش
                      </SecondaryButton>
                    ) : null}
                    <select
                      className={`${inputClass} w-auto py-1`}
                      value={settlementByPurchase[p.id] ?? "credit"}
                      onChange={(e) => setSettlementByPurchase((prev) => ({ ...prev, [p.id]: e.target.value }))}
                    >
                      {Object.entries(SETTLEMENT_LABELS).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <SecondaryButton
                      disabled={busy}
                      onClick={() => transition(p.id, "received", settlementByPurchase[p.id] ?? "credit")}
                    >
                      دریافت کالا
                    </SecondaryButton>
                    <SecondaryButton disabled={busy} onClick={() => transition(p.id, "cancelled")}>
                      لغو
                    </SecondaryButton>
                  </>
                ) : null}
              </div>
            </li>
          ))}
          {purchases && purchases.length === 0 ? <li className="p-3 text-sm text-stone-400">خریدی ثبت نشده است.</li> : null}
        </ul>
      </section>
    </div>
  );
}
