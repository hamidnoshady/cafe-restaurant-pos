"use client";

import { useCallback, useEffect, useState } from "react";
import Decimal from "decimal.js";
import { formatQuantity } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, Field, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { InventoryItem, Runner, Supplier } from "./inventory-manager";

interface Purchase {
  id: string;
  status: "draft" | "ordered" | "received" | "cancelled";
  total: string | number;
  note: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  /** The date entered for the purchase itself (ISO), independent of created_at. */
  purchase_date: string;
  ordered_at: string | null;
  received_at: string | null;
  created_at: string;
}

/** One stored line. quantity/unit_cost are in the item's *base* unit. */
interface PurchaseDetailItem {
  id: string;
  inventory_item_id: string;
  inventory_item_name: string;
  unit: string;
  purchase_unit: string | null;
  purchase_unit_factor: string | number;
  quantity: string | number;
  unit_cost: string | number;
  extended_cost: string | number;
  inventory_lot_id: string | null;
}

interface PurchaseDetail {
  purchase: Purchase & { created_by_name?: string | null };
  items: PurchaseDetailItem[];
}

interface DraftLine {
  inventoryItemId: string;
  purchaseQty: string;
  totalCost: string;
  /**
   * What this line held when the edit form opened: the exact stored Rial value
   * and the Toman text rendered from it. The form edits Toman, but Toman is a
   * lossy view of Rial (formatMoneyText floors by 10 in the Toman display), so a line the user never
   * touched is written back from `rial` verbatim rather than re-parsed — saving
   * an untouched purchase must not silently round its own amounts.
   * Unset on the create form, which has no prior value.
   */
  original?: { text: string; rial: string };
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

const emptyLine = (): DraftLine => ({ inventoryItemId: "", purchaseQty: "", totalCost: "" });

/** Only an unreceived purchase may be edited — see the PUT handler's doc comment. */
function isEditable(status: Purchase["status"]) {
  return status === "draft" || status === "ordered";
}

/**
 * Stored base-unit quantity -> the purchase-unit quantity the user typed
 * (e.g. 5000 g back to 5 kg), so an edit form round-trips what was entered
 * rather than showing the converted value.
 */
function toPurchaseQty(quantity: string | number, factor: string | number): string {
  try {
    const f = new Decimal(String(factor));
    if (f.lte(0)) return String(quantity);
    return new Decimal(String(quantity)).div(f).toFixed();
  } catch {
    return String(quantity);
  }
}

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
  const money = useMoney();
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [settlementByPurchase, setSettlementByPurchase] = useState<Record<string, string>>({});
  const [supplierByPurchase, setSupplierByPurchase] = useState<Record<string, string>>({});

  // Filters
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  // Expanded row detail, keyed by purchase id. `null` = loading.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PurchaseDetail | null>(null);

  // Edit form state, populated from the detail when editing starts.
  const [editing, setEditing] = useState(false);
  const [editSupplierId, setEditSupplierId] = useState("");
  const [editPurchaseDate, setEditPurchaseDate] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editLines, setEditLines] = useState<DraftLine[]>([]);
  const [returning, setReturning] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [returnSettlement, setReturnSettlement] = useState<"accounts_payable" | "cash" | "bank" | "supplier_receivable">("accounts_payable");
  const [returnQuantities, setReturnQuantities] = useState<Record<string, string>>({});

  const loadPurchases = useCallback(() => {
    const params = new URLSearchParams();
    if (filterStatus) params.set("status", filterStatus);
    if (filterSupplier) params.set("supplierId", filterSupplier);
    if (filterFrom) params.set("dateFrom", filterFrom);
    if (filterTo) params.set("dateTo", filterTo);
    const qs = params.toString();
    api<{ purchases: Purchase[] }>(`/api/inventory/purchases${qs ? `?${qs}` : ""}`).then(({ ok, data }) => {
      if (ok) setPurchases(data.purchases);
    });
  }, [filterStatus, filterSupplier, filterFrom, filterTo]);
  useEffect(loadPurchases, [loadPurchases]);

  const loadDetail = useCallback((id: string) => {
    setDetail(null);
    api<PurchaseDetail>(`/api/inventory/purchases/${id}`).then(({ ok, data }) => {
      if (ok) setDetail(data);
    });
  }, []);

  function toggleExpanded(id: string) {
    setEditing(false);
    setReturning(false);
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    loadDetail(id);
  }

  /**
   * `purchaseDate` comes from the list row rather than the loaded detail: the
   * list endpoint hands purchase_date back as ISO text, where the detail's
   * `SELECT p.*` would serialise the `date` column through the server's own
   * timezone and could prefill the picker a day off.
   */
  function startEditing(purchaseDate: string) {
    if (!detail) return;
    setEditSupplierId(detail.purchase.supplier_id ?? "");
    setEditPurchaseDate(purchaseDate);
    setEditNote(detail.purchase.note ?? "");
    setEditLines(
      detail.items.map((it) => {
        const rial = String(it.extended_cost);
        // Stored in Rial; the form edits Toman, the same unit the create form uses.
        const text = money.formatText(rial, { withUnit: false });
        return {
          inventoryItemId: it.inventory_item_id,
          purchaseQty: toPurchaseQty(it.quantity, it.purchase_unit_factor),
          totalCost: text,
          original: { text, rial },
        };
      }),
    );
    setEditing(true);
  }

  const activeItems = items.filter((i) => i.is_active);
  const activeSuppliers = suppliers.filter((s) => s.is_active);

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }
  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  /** Shared by create and edit: drop blank rows and convert Toman -> Rial text. */
  function toPayloadLines(source: DraftLine[]) {
    return source
      .filter((l) => l.inventoryItemId && l.purchaseQty.trim())
      .map((l) => {
        let totalCostRial: string;
        if (l.original && l.totalCost === l.original.text) {
          // Untouched line — keep the stored Rial exactly (see DraftLine.original).
          totalCostRial = l.original.rial;
        } else {
          try {
            totalCostRial = money.parseText(l.totalCost || "0");
          } catch {
            totalCostRial = "";
          }
        }
        return { inventoryItemId: l.inventoryItemId, purchaseQty: l.purchaseQty, totalCost: totalCostRial };
      });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const payloadLines = toPayloadLines(lines);
    if (payloadLines.length === 0) return;

    const ok = await run(() =>
      api("/api/inventory/purchases", {
        method: "POST",
        body: JSON.stringify({
          supplierId: supplierId || null,
          purchaseDate: purchaseDate || null,
          note,
          items: payloadLines,
        }),
      }),
    );
    if (ok) {
      setNote("");
      setLines([emptyLine()]);
      loadPurchases();
    }
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!expandedId) return;
    const payloadLines = toPayloadLines(editLines);
    if (payloadLines.length === 0) return;

    const ok = await run(() =>
      api(`/api/inventory/purchases/${expandedId}`, {
        method: "PUT",
        body: JSON.stringify({
          supplierId: editSupplierId || null,
          purchaseDate: editPurchaseDate || null,
          note: editNote,
          items: payloadLines,
        }),
      }),
    );
    if (ok) {
      setEditing(false);
      loadPurchases();
      loadDetail(expandedId);
    }
  }

  async function transition(id: string, status: string, settlementMethod?: string) {
    const ok = await run(() =>
      api(`/api/inventory/purchases/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, settlementMethod, supplierId: supplierByPurchase[id] || undefined }),
      }),
    );
    if (ok) {
      loadPurchases();
      if (expandedId === id) loadDetail(id);
    }
  }

  function startReturning() {
    if (!detail) return;
    setReturnReason("");
    setReturnSettlement("accounts_payable");
    setReturnQuantities(Object.fromEntries(detail.items.map((it) => [it.id, ""])));
    setReturning(true);
  }

  async function submitReturn(e: React.FormEvent) {
    e.preventDefault();
    if (!expandedId || !returnReason.trim() || !detail) return;
    const lines = detail.items
      .map((it) => ({
        purchaseItemId: it.id,
        inventoryLotId: it.inventory_lot_id,
        quantity: returnQuantities[it.id]?.trim() ?? "",
      }))
      .filter((line) => line.quantity);
    if (lines.length === 0) return;
    const ok = await run(() => api(`/api/inventory/supplier-returns`, {
      method: "POST",
      body: JSON.stringify({
        purchaseId: expandedId,
        settlementMethod: returnSettlement,
        reason: returnReason,
        idempotencyKey: `${expandedId}-${Date.now()}`,
        lines,
      }),
    }));
    if (ok) {
      setReturning(false);
      loadDetail(expandedId);
      loadPurchases();
    }
  }

  async function removePurchase(id: string) {
    if (!window.confirm("این خرید حذف شود؟ خرید دریافت‌شده برای حفظ موجودی و اسناد حسابداری قابل حذف نیست.")) return;
    const ok = await run(() => api(`/api/inventory/purchases/${id}`, { method: "DELETE" }));
    if (ok) {
      if (expandedId === id) {
        setExpandedId(null);
        setDetail(null);
        setEditing(false);
      }
      loadPurchases();
    }
  }

  /** The per-line editor row, shared by the create form and the edit form. */
  function lineRows(source: DraftLine[], onChange: (i: number, patch: Partial<DraftLine>) => void, onRemove: (i: number) => void) {
    return source.map((line, i) => {
      const invItem = items.find((it) => it.id === line.inventoryItemId);
      return (
        <div key={i} className="grid min-w-0 gap-3 rounded-xl border border-border p-3 sm:grid-cols-2 xl:grid-cols-5">
          <Field label="قلم انبار">
            <SearchableSelect
              value={line.inventoryItemId}
              onChange={(value) => onChange(i, { inventoryItemId: value })}
              options={[
                { value: "", label: "قلم انبار را انتخاب کنید…" },
                ...activeItems.map((it) => ({
                  value: it.id,
                  label: it.name,
                  searchString: [it.name, it.sku, it.unit].filter(Boolean).join(" "),
                })),
              ]}
            />
          </Field>
          <Field label={`مقدار خرید (${invItem?.purchase_unit || invItem?.unit || "واحد"})`}>
            <input
              className={inputClass}
              dir="ltr"
              inputMode="decimal"
              value={line.purchaseQty}
              onChange={(e) => onChange(i, { purchaseQty: e.target.value })}
            />
          </Field>
          <Field label={`مبلغ کل (${money.unitLabel})`}>
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={line.totalCost}
              onChange={(e) => onChange(i, { totalCost: e.target.value })}
            />
          </Field>
          <span className="mb-4 self-end break-words text-xs text-muted-foreground">
            {invItem?.purchase_unit
              ? `= ${formatQuantity(invItem.purchase_unit_factor)} ${invItem.unit} به ازای هر واحد خرید`
              : "واحد خرید انتخاب‌شده را مشخص کنید."}
          </span>
          <div className="mb-4 flex items-end">
            <SecondaryButton onClick={() => onRemove(i)} disabled={source.length === 1}>
              حذف ردیف
            </SecondaryButton>
          </div>
        </div>
      );
    });
  }

  return (
    <div className="space-y-6">
      <section className="min-w-0 rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">ثبت خرید (رسید ورود کالا)</h2>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Field label="تأمین‌کننده">
              <SearchableSelect
                value={supplierId}
                onChange={setSupplierId}
                options={[
                  { value: "", label: "بدون تأمین‌کننده" },
                  ...activeSuppliers.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            </Field>
            <Field label="تاریخ خرید">
              <JalaliDatePicker value={purchaseDate} onChange={setPurchaseDate} placeholder="امروز" />
            </Field>
            <Field label="یادداشت">
              <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="اختیاری" />
            </Field>
          </div>

          <div className="space-y-2">{lineRows(lines, updateLine, removeLine)}</div>
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

        <div className="mb-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="وضعیت">
            <SearchableSelect
              value={filterStatus}
              onChange={setFilterStatus}
              options={[
                { value: "", label: "همه وضعیت‌ها" },
                ...(Object.keys(STATUS_LABELS) as Purchase["status"][]).map((s) => ({
                  value: s,
                  label: STATUS_LABELS[s],
                })),
              ]}
            />
          </Field>
          <Field label="تأمین‌کننده">
            <SearchableSelect
              value={filterSupplier}
              onChange={setFilterSupplier}
              options={[
                { value: "", label: "همه تأمین‌کنندگان" },
                ...suppliers.map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
          </Field>
          <Field label="از تاریخ">
            <JalaliDatePicker value={filterFrom} onChange={setFilterFrom} placeholder="بدون محدودیت" />
          </Field>
          <Field label="تا تاریخ">
            <JalaliDatePicker value={filterTo} onChange={setFilterTo} placeholder="بدون محدودیت" />
          </Field>
        </div>

        <ul className="divide-y divide-border rounded-lg border border-border">
          {(purchases ?? []).map((p) => {
            const isExpanded = expandedId === p.id;
            return (
              <li key={p.id} className="min-w-0 px-3 py-4 text-sm sm:px-4">
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0 break-words">
                    {p.supplier_name ?? "بدون تأمین‌کننده"} — {money.formatText(String(p.total))} —{" "}
                    <span className="text-xs text-muted-foreground">{formatJalali(p.purchase_date)}</span>
                  </span>
                  <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-end">
                    <span className="text-xs">{STATUS_LABELS[p.status]}</span>
                    {p.status !== "cancelled" ? (
                      <SecondaryButton onClick={() => toggleExpanded(p.id)}>
                        {isExpanded ? "بستن" : "مشاهده جزئیات"}
                      </SecondaryButton>
                    ) : null}
                    {p.status === "draft" || p.status === "ordered" ? (
                      <>
                        {p.status === "draft" ? (
                          <SecondaryButton disabled={busy} onClick={() => transition(p.id, "ordered")}>
                            ثبت سفارش
                          </SecondaryButton>
                        ) : null}
                        <label className="grid min-w-36 max-w-full gap-1 text-xs font-medium">
                          <span>روش تسویه</span>
                          <SearchableSelect
                            value={settlementByPurchase[p.id] ?? "credit"}
                            onChange={(value) => setSettlementByPurchase((prev) => ({ ...prev, [p.id]: value }))}
                            options={Object.entries(SETTLEMENT_LABELS).map(([key, label]) => ({
                              value: key,
                              label,
                            }))}
                          />
                        </label>
                        {!p.supplier_name && (settlementByPurchase[p.id] ?? "credit") === "credit" ? (
                          <div className="grid min-w-36 max-w-full gap-1 text-xs font-medium">
                            <span>تأمین‌کنندهٔ خرید نسیه</span>
                            <SearchableSelect
                              value={supplierByPurchase[p.id] ?? ""}
                              onChange={(v) => setSupplierByPurchase((prev) => ({ ...prev, [p.id]: v }))}
                              options={[
                                { value: "", label: "تأمین‌کننده را انتخاب کنید…" },
                                ...activeSuppliers.map((s) => ({ value: s.id, label: s.name })),
                              ]}
                            />
                          </div>
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
                </div>

                {isExpanded ? (
                  <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3">
                    {!detail ? (
                      <p className="text-xs text-muted-foreground">در حال بارگذاری…</p>
                    ) : editing ? (
                      <form onSubmit={saveEdit} className="space-y-3">
                        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                          <Field label="تأمین‌کننده">
                            <SearchableSelect
                              value={editSupplierId}
                              onChange={setEditSupplierId}
                              options={[
                                { value: "", label: "بدون تأمین‌کننده" },
                                ...activeSuppliers.map((s) => ({ value: s.id, label: s.name })),
                              ]}
                            />
                          </Field>
                          <Field label="تاریخ خرید">
                            <JalaliDatePicker value={editPurchaseDate} onChange={setEditPurchaseDate} />
                          </Field>
                          <Field label="یادداشت">
                            <input className={inputClass} value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="اختیاری" />
                          </Field>
                        </div>
                        <div className="space-y-2">
                          {lineRows(
                            editLines,
                            (i, patch) => setEditLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l))),
                            (i) => setEditLines((prev) => prev.filter((_, idx) => idx !== i)),
                          )}
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <SecondaryButton onClick={() => setEditLines((prev) => [...prev, emptyLine()])}>افزودن ردیف</SecondaryButton>
                          <SecondaryButton onClick={() => setEditing(false)}>انصراف</SecondaryButton>
                          <div className="w-full sm:w-52">
                            <PrimaryButton disabled={busy}>ذخیره تغییرات</PrimaryButton>
                          </div>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-border">
                                <th className="py-2 pe-3 text-start font-medium">قلم انبار</th>
                                <th className="py-2 pe-3 text-start font-medium">مقدار</th>
                                <th className="py-2 pe-3 text-start font-medium">بهای واحد</th>
                                <th className="py-2 text-start font-medium">مبلغ کل</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.items.map((it) => (
                                <tr key={it.id} className="border-b border-border/60 last:border-0">
                                  <td className="py-2 pe-3">{it.inventory_item_name}</td>
                                  <td className="whitespace-nowrap py-2 pe-3">
                                    {formatQuantity(it.quantity)} {it.unit}
                                  </td>
                                  <td className="whitespace-nowrap py-2 pe-3 text-muted-foreground">
                                    {/* unit_cost is numeric(24,9); formatText only accepts integer Rial. */}
                                    {money.formatText(new Decimal(String(it.unit_cost)).toFixed(0))}
                                  </td>
                                  <td className="whitespace-nowrap py-2">{money.formatText(String(it.extended_cost))}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs sm:grid-cols-4">
                          <div>
                            <dt className="text-muted-foreground">تاریخ خرید</dt>
                            <dd className="mt-0.5">{formatJalali(p.purchase_date)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">ثبت</dt>
                            <dd className="mt-0.5">{formatJalali(detail.purchase.created_at)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">سفارش</dt>
                            <dd className="mt-0.5">{detail.purchase.ordered_at ? formatJalali(detail.purchase.ordered_at) : "—"}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">دریافت</dt>
                            <dd className="mt-0.5">{detail.purchase.received_at ? formatJalali(detail.purchase.received_at) : "—"}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">یادداشت</dt>
                            <dd className="mt-0.5 break-words">{detail.purchase.note || "—"}</dd>
                          </div>
                        </dl>

                        {returning ? (
                          <form onSubmit={submitReturn} className="mt-4 space-y-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                            <p className="text-sm font-semibold">برگشت کالا به تأمین‌کننده</p>
                            <p className="text-xs text-muted-foreground">مقدار برگشتی را در واحد پایه وارد کنید. قیمت‌ها در سیستم به ریال ذخیره می‌شوند و اینجا به تومان نمایش داده می‌شوند.</p>
                            <div className="space-y-2">
                              {detail.items.map((it) => (
                                <div key={it.id} className="grid gap-2 sm:grid-cols-[1fr_9rem] sm:items-end">
                                  <span className="text-sm">{it.inventory_item_name} <span className="text-xs text-muted-foreground">({formatQuantity(it.quantity)} {it.unit})</span></span>
                                  <Field label={`مقدار برگشت (${it.unit})`}>
                                    <input className={inputClass} dir="ltr" inputMode="decimal" value={returnQuantities[it.id] ?? ""} onChange={(e) => setReturnQuantities((prev) => ({ ...prev, [it.id]: e.target.value }))} />
                                  </Field>
                                </div>
                              ))}
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <Field label="روش تسویه">
                                <SearchableSelect value={returnSettlement} onChange={(v) => setReturnSettlement(v as typeof returnSettlement)} options={[
                                  { value: "accounts_payable", label: "کاهش بدهی تأمین‌کننده" },
                                  { value: "cash", label: "نقدی" },
                                  { value: "bank", label: "بانکی" },
                                  { value: "supplier_receivable", label: "طلب از تأمین‌کننده" },
                                ]} />
                              </Field>
                              <Field label="دلیل برگشت">
                                <input className={inputClass} value={returnReason} onChange={(e) => setReturnReason(e.target.value)} placeholder="مثلاً کالای معیوب" required />
                              </Field>
                            </div>
                            <div className="flex flex-col gap-2 sm:flex-row">
                              <PrimaryButton disabled={busy}>ثبت برگشت</PrimaryButton>
                              <SecondaryButton onClick={() => setReturning(false)}>انصراف</SecondaryButton>
                            </div>
                          </form>
                        ) : null}

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {isEditable(p.status) ? (
                            <SecondaryButton disabled={busy} onClick={() => startEditing(p.purchase_date)}>
                              ویرایش
                            </SecondaryButton>
                          ) : (
                            <>
                              <SecondaryButton disabled={busy} onClick={startReturning}>
                                برگشت به تأمین‌کننده
                              </SecondaryButton>
                              <p className="text-xs text-muted-foreground">
                                خرید دریافت‌شده قابل ویرایش نیست؛ برای اصلاح از «برگشت به تأمین‌کننده» استفاده کنید.
                              </p>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
          {purchases && purchases.length === 0 ? <li className="p-3 text-sm text-muted-foreground">خریدی ثبت نشده است.</li> : null}
        </ul>
      </section>
    </div>
  );
}
