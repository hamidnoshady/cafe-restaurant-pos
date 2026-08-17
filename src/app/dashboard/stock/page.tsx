"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { api, ErrorBox, Field, inputClass } from "../ui";

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

interface ReportRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  quantity: string;
  reorderPoint?: string;
  level?: "out" | "low";
  lastSoldAt?: string | null;
  valueRial?: number;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.035)] sm:p-5">
      <h2 className="font-semibold text-stone-950">{title}</h2>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

export default function StockPage() {
  const [items, setItems] = useState<StockItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchases, setPurchases] = useState<PurchaseRow[]>([]);
  const [low, setLow] = useState<ReportRow[]>([]);
  const [dead, setDead] = useState<ReportRow[]>([]);
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
    api<{ low: ReportRow[]; dead: ReportRow[] }>("/api/stock/reports").then(({ ok, data }) => {
      if (ok) {
        setLow(data.low);
        setDead(data.dead);
      }
    });
  }, []);
  useEffect(load, [load]);

  return (
    <div className="mx-auto w-full max-w-[1100px]">
      <header className="mb-5 border-b border-stone-200/80 pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-stone-950">خرید و انبار</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          خرید، برگشت به تأمین‌کننده، انتقال بین شعبه‌ها و گزارش کمبود/راکد موجودی.
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>
      {done ? <p className="mb-3 text-xs text-emerald-700">{done}</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <PurchaseForm
          items={items}
          suppliers={suppliers}
          onDone={(m) => {
            setDone(m);
            load();
          }}
          onError={setError}
        />
        <ReturnForm items={items} onDone={(m) => { setDone(m); load(); }} onError={setError} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="کمبود موجودی (زیر نقطهٔ سفارش)">
          {low.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-muted-foreground">چیزی زیر نقطهٔ سفارش نیست.</p>
          ) : (
            <ul className="divide-y divide-stone-200/80 text-sm">
              {low.map((r) => (
                <li key={r.itemId} className="flex items-center justify-between gap-3 py-2">
                  <span className="font-medium text-stone-950">{r.itemName}</span>
                  <span className="text-xs text-amber-700">
                    {formatPersianNumber(Number(r.quantity))} از {formatPersianNumber(Number(r.reorderPoint ?? "0"))} {r.level === "out" ? "· تمام شده" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="کالای راکد (۹۰ روز بدون فروش)">
          {dead.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-muted-foreground">کالای راکدی نیست.</p>
          ) : (
            <ul className="divide-y divide-stone-200/80 text-sm">
              {dead.map((r) => (
                <li key={r.itemId} className="flex items-center justify-between gap-3 py-2">
                  <span className="font-medium text-stone-950">{r.itemName}</span>
                  <span className="text-xs text-muted-foreground">{formatToman(r.valueRial ?? 0)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title="خریدهای اخیر">
          {purchases.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-muted-foreground">هنوز خریدی ثبت نشده است.</p>
          ) : (
            <ul className="divide-y divide-stone-200/80 text-sm">
              {purchases.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="font-medium text-stone-950">{p.supplierName ?? "بدون تأمین‌کننده"}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatPersianNumber(p.lineCount)} قلم · {formatToman(p.total)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
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
      { itemId, quantity, unitCost: Number(unitCost), expiryDate: expiry || null },
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
    <Panel title="دریافت خرید">
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
            <input className={inputClass} dir="ltr" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Button type="button" variant="outline" onClick={addLine} className="min-h-11">+</Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="بهای هر واحد (تومان)">
            <input className={inputClass} dir="ltr" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
          </Field>
          <Field label="انقضا (اختیاری، میلادی)">
            <input className={inputClass} dir="ltr" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
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
    </Panel>
  );
}

function ReturnForm({
  items,
  onDone,
  onError,
}: {
  items: StockItem[];
  onDone: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!itemId || !quantity.trim() || !reason.trim()) return;
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/stock/returns", {
      method: "POST",
      body: JSON.stringify({ reason, lines: [{ itemId, quantity }] }),
    });
    setBusy(false);
    if (!ok) onError(data.message ?? "ثبت برگشت ناموفق بود.");
    else {
      setItemId("");
      setQuantity("1");
      setReason("");
      onDone("برگشت به تأمین‌کننده ثبت شد.");
    }
  }

  return (
    <Panel title="برگشت به تأمین‌کننده">
      <div className="grid gap-2">
        <Field label="کالا">
          <select className={inputClass} value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">انتخاب کنید…</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="تعداد">
            <input className={inputClass} dir="ltr" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Field label="دلیل">
            <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        <Button type="button" disabled={busy} onClick={() => void submit()} className="min-h-11 w-full">
          ثبت برگشت
        </Button>
      </div>
    </Panel>
  );
}
