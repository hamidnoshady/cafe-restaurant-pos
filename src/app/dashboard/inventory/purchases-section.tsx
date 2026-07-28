"use client";

import { useCallback, useEffect, useState } from "react";
import { formatQuantity } from "@/lib/digits";
import { formatTomanText, parseToRialText } from "@/lib/money";
import { formatJalali } from "@/lib/jalali";
import { api, Field, inputClass, PrimaryButton, SecondaryButton } from "../ui";
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
  const [supplierByPurchase, setSupplierByPurchase] = useState<Record<string, string>>({});

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
        let totalCostRial: string;
        try {
          totalCostRial = parseToRialText(l.totalCost || "0", "toman");
        } catch {
          totalCostRial = "";
        }
        return { inventoryItemId: l.inventoryItemId, purchaseQty: l.purchaseQty, totalCost: totalCostRial };
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
      api(`/api/inventory/purchases/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, settlementMethod, supplierId: supplierByPurchase[id] || undefined }),
      }),
    );
    if (ok) loadPurchases();
  }

  async function removePurchase(id: string) {
    if (!window.confirm("این خرید حذف شود؟ خرید دریافت‌شده برای حفظ موجودی و اسناد حسابداری قابل حذف نیست.")) return;
    const ok = await run(() => api(`/api/inventory/purchases/${id}`, { method: "DELETE" }));
    if (ok) loadPurchases();
  }

  return (
    <div className="space-y-6">
      <section className="min-w-0 rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">ثبت خرید (رسید ورود کالا)</h2>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <Field label="تأمین‌کننده">
              <select className={inputClass} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">بدون تأمین‌کننده</option>
                {suppliers.filter((s) => s.is_active).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="یادداشت">
              <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="اختیاری" />
            </Field>
          </div>

          <div className="space-y-2">
            {lines.map((line, i) => {
              const invItem = items.find((it) => it.id === line.inventoryItemId);
              return (
                <div key={i} className="grid min-w-0 gap-3 rounded-xl border border-border p-3 sm:grid-cols-2 xl:grid-cols-5">
                  <Field label="قلم انبار">
                    <select
                      className={inputClass}
                      value={line.inventoryItemId}
                      onChange={(e) => updateLine(i, { inventoryItemId: e.target.value })}
                    >
                      <option value="">قلم انبار را انتخاب کنید…</option>
                      {activeItems.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={`مقدار خرید (${invItem?.purchase_unit || invItem?.unit || "واحد"})`}>
                    <input
                      className={inputClass}
                      dir="ltr"
                      inputMode="decimal"
                      value={line.purchaseQty}
                      onChange={(e) => updateLine(i, { purchaseQty: e.target.value })}
                    />
                  </Field>
                  <Field label="مبلغ کل (تومان)">
                    <input
                      className={inputClass}
                      dir="ltr"
                      inputMode="numeric"
                      value={line.totalCost}
                      onChange={(e) => updateLine(i, { totalCost: e.target.value })}
                    />
                  </Field>
                  <span className="mb-4 self-end break-words text-xs text-muted-foreground">
                    {invItem?.purchase_unit
                      ? `= ${formatQuantity(invItem.purchase_unit_factor)} ${invItem.unit} به ازای هر واحد خرید`
                      : "واحد خرید انتخاب‌شده را مشخص کنید."}
                  </span>
                  <div className="mb-4 flex items-end">
                    <SecondaryButton onClick={() => removeLine(i)} disabled={lines.length === 1}>
                      حذف ردیف
                    </SecondaryButton>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <SecondaryButton onClick={addLine}>افزودن ردیف</SecondaryButton>
            <div className="w-full sm:w-52">
              <PrimaryButton disabled={busy}>ثبت پیش‌نویس خرید</PrimaryButton>
            </div>
          </div>
        </form>
      </section>

      <section className="min-w-0 rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">خریدهای اخیر</h2>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {(purchases ?? []).map((p) => (
            <li key={p.id} className="flex min-w-0 flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 break-words">
                {p.supplier_name ?? "بدون تأمین‌کننده"} — {formatTomanText(String(p.total))} —{" "}
                <span className="text-xs text-muted-foreground">{formatJalali(p.created_at)}</span>
              </span>
              <div className="flex flex-wrap items-end gap-2">
                <span className="text-xs">{STATUS_LABELS[p.status]}</span>
                {p.status === "draft" || p.status === "ordered" ? (
                  <>
                    {p.status === "draft" ? (
                      <SecondaryButton disabled={busy} onClick={() => transition(p.id, "ordered")}>
                        ثبت سفارش
                      </SecondaryButton>
                    ) : null}
                    <label className="grid min-w-36 max-w-full gap-1 text-xs font-medium">
                      <span>روش تسویه</span>
                      <select
                        className={inputClass}
                        value={settlementByPurchase[p.id] ?? "credit"}
                        onChange={(e) => setSettlementByPurchase((prev) => ({ ...prev, [p.id]: e.target.value }))}
                      >
                        {Object.entries(SETTLEMENT_LABELS).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!p.supplier_name && (settlementByPurchase[p.id] ?? "credit") === "credit" ? (
                      <label className="grid min-w-36 max-w-full gap-1 text-xs font-medium">
                        <span>تأمین‌کنندهٔ خرید نسیه</span>
                        <select
                          className={inputClass}
                          value={supplierByPurchase[p.id] ?? ""}
                          onChange={(e) => setSupplierByPurchase((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        >
                          <option value="">تأمین‌کننده را انتخاب کنید…</option>
                          {suppliers.filter((s) => s.is_active).map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <SecondaryButton
                      disabled={busy || (!p.supplier_name && (settlementByPurchase[p.id] ?? "credit") === "credit" && !supplierByPurchase[p.id])}
                      onClick={() => transition(p.id, "received", settlementByPurchase[p.id] ?? "credit")}
                    >
                      دریافت کالا
                    </SecondaryButton>
                    <SecondaryButton disabled={busy} onClick={() => transition(p.id, "cancelled")}>
                      لغو
                    </SecondaryButton>
                  </>
                ) : null}
                {p.status !== "received" ? (
                  <SecondaryButton disabled={busy} onClick={() => void removePurchase(p.id)}>
                    حذف
                  </SecondaryButton>
                ) : null}
              </div>
            </li>
          ))}
          {purchases && purchases.length === 0 ? <li className="p-3 text-sm text-muted-foreground">خریدی ثبت نشده است.</li> : null}
        </ul>
      </section>
    </div>
  );
}
