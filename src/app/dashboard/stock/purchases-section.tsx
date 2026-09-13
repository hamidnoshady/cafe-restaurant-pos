"use client";

/**
 * Phase 42b — the «خرید» tab: the purchase-receiving form and the recent
 * purchases list, extracted unchanged from the old one-page /accounting/stock
 * (Phase 27 Wave 8's retail purchasing) into the warehouse module's «اقلام و
 * عملیات» group. The form's fields, line building and POST payload are
 * byte-for-byte the originals; only the data loading moved into the section.
 */
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { SectionCard, SectionCardSkeleton } from "../page-chrome";
import { JalaliDatePicker } from "../jalali-date-picker";

interface StockItem {
  id: string;
  name: string;
  sku: string | null;
  tracking: string;
  quantity: string;
  unitCost: number | null;
  unitPrice: number | null;
}

interface Supplier {
  id: string;
  name: string;
}

interface PurchaseRow {
  id: string;
  total: number;
  supplierName: string | null;
  lineCount: number;
  receivedAt: string;
}

export function PurchasesSection() {
  const money = useMoney();
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [purchases, setPurchases] = useState<PurchaseRow[] | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(() => {
    api<{ items: StockItem[] }>("/api/stock/items").then(({ ok, data }) => ok && setItems(data.items));
    api<{ purchases: PurchaseRow[]; suppliers: Supplier[] }>("/api/stock/purchases").then(({ ok, data }) => {
      if (ok) {
        setPurchases(data.purchases);
        setSuppliers(data.suppliers);
      }
    });
  }, []);
  useEffect(load, [load]);

  if (items === null || suppliers === null || purchases === null) {
    return (
      <div className="space-y-4">
        <SectionCardSkeleton rows={4} />
        <SectionCardSkeleton rows={5} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PurchaseForm
        items={items}
        suppliers={suppliers}
        onDone={(m) => {
          setDone(m);
          load();
        }}
        onError={setError}
      />

      <SectionCard title="خریدهای اخیر" bodyClassName="space-y-3">
        {purchases.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">هنوز خریدی ثبت نشده است.</p>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {purchases.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <span className="font-medium text-foreground">{p.supplierName ?? "بدون تأمین‌کننده"}</span>
                <span className="text-xs text-muted-foreground">
                  {formatPersianNumber(p.lineCount)} قلم · {money.format(p.total)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <ErrorBox>{error}</ErrorBox>
      {done ? <p className="text-xs text-emerald-700 dark:text-emerald-300">{done}</p> : null}
    </div>
  );
}

function PurchaseForm({
  items,
  suppliers,
  onDone,
  onError,
}: {
  items: StockItem[];
  suppliers: Supplier[];
  onDone: (m: string) => void;
  onError: (m: string) => void;
}) {
  const money = useMoney();
  const [supplierId, setSupplierId] = useState("");
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitCost, setUnitCost] = useState("");
  const [expiry, setExpiry] = useState("");
  const [lines, setLines] = useState<{ itemId: string; quantity: string; unitCost: number; expiryDate: string | null }[]>([]);
  const [busy, setBusy] = useState(false);

  function addLine() {
    if (!itemId || !quantity.trim() || !unitCost.trim()) return;
    setLines((prev) => [
      ...prev,
      { itemId, quantity, unitCost: money.fromInput(Math.max(0, Math.round(Number(unitCost)))), expiryDate: expiry || null },
    ]);
    setItemId("");
    setQuantity("1");
    setUnitCost("");
    setExpiry("");
  }

  async function submit() {
    if (lines.length === 0) return;
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/stock/purchases", {
      method: "POST",
      body: JSON.stringify({ supplierId: supplierId || null, lines }),
    });
    setBusy(false);
    if (!ok) onError(data.message ?? "ثبت خرید ناموفق بود.");
    else {
      setLines([]);
      setSupplierId("");
      onDone("خرید دریافت شد (بدهکار موجودی، بستانکار حساب‌های پرداختنی).");
    }
  }

  const itemName = (id: string) => items.find((i) => i.id === id)?.name ?? id;

  return (
    <SectionCard title="دریافت خرید" bodyClassName="space-y-3">
      <div className="grid gap-2">
        <Field label="تأمین‌کننده">
          <select className={inputClass} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">بدون تأمین‌کننده</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <Field label="کالا">
            <select className={inputClass} value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">انتخاب کنید…</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </Field>
          <Field label="تعداد">
            <PersianNumberInput inputMode="decimal" className={inputClass} dir="ltr" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Button type="button" variant="outline" onClick={addLine} className="min-h-11">+</Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label={`بهای هر واحد (${money.unitLabel})`}>
            <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
          </Field>
          <Field label="انقضا (اختیاری، شمسی)">
            <JalaliDatePicker className={inputClass} value={expiry} onChange={setExpiry} />
          </Field>
        </div>
        {lines.length > 0 ? (
          <ul className="text-xs text-muted-foreground">
            {lines.map((l, i) => (
              <li key={i}>{itemName(l.itemId)} × {formatPersianNumber(Number(l.quantity))}</li>
            ))}
          </ul>
        ) : null}
        <Button type="button" disabled={busy || lines.length === 0} onClick={() => void submit()} className="min-h-11 w-full">
          ثبت خرید
        </Button>
      </div>
    </SectionCard>
  );
}
