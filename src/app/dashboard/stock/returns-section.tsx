"use client";

/**
 * Phase 42b — the «حواله بازگشت» tab: the supplier-return form, extracted
 * unchanged from the old one-page /accounting/stock (Phase 27 Wave 8's retail
 * supplier returns) into the warehouse module's «اقلام و عملیات» group. The
 * form's fields and POST payload are byte-for-byte the originals; only the
 * data loading moved into the section. Kept separate from the warehouse
 * document (حواله انبار) on purpose: a return TO a supplier settles against
 * the supplier, a warehouse issue does not.
 */
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { SectionCard, SectionCardSkeleton } from "../page-chrome";

interface StockItem {
  id: string;
  name: string;
  sku: string | null;
  tracking: string;
  quantity: string;
  unitCost: number | null;
  unitPrice: number | null;
}

export function ReturnsSection() {
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(() => {
    api<{ items: StockItem[] }>("/api/stock/items").then(({ ok, data }) => ok && setItems(data.items));
  }, []);
  useEffect(load, [load]);

  if (items === null) {
    return <SectionCardSkeleton rows={4} />;
  }

  return (
    <div className="space-y-3">
      <ReturnForm
        items={items}
        onDone={(m) => {
          setDone(m);
          load();
        }}
        onError={setError}
      />
      <ErrorBox>{error}</ErrorBox>
      {done ? <p className="text-xs text-emerald-700 dark:text-emerald-300">{done}</p> : null}
    </div>
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
    <SectionCard title="برگشت به تأمین‌کننده" bodyClassName="space-y-3">
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
            <PersianNumberInput inputMode="decimal" className={inputClass} dir="ltr" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Field label="دلیل">
            <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        <Button type="button" disabled={busy} onClick={() => void submit()} className="min-h-11 w-full">
          ثبت برگشت
        </Button>
      </div>
    </SectionCard>
  );
}
