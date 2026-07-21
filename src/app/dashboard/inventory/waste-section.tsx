"use client";

import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { formatJalali } from "@/lib/jalali";
import { api, inputClass, PrimaryButton } from "../ui";
import type { InventoryItem, Runner } from "./inventory-manager";

interface WasteEntry {
  id: string;
  inventory_item_id: string;
  inventory_item_name: string;
  unit: string;
  quantity: string | number;
  unit_cost: string | number;
  waste_reason: string;
  note: string | null;
  occurred_at: string;
}

const REASON_LABELS: Record<string, string> = {
  spoilage: "فساد",
  prep_error: "خطای آماده‌سازی",
  customer_return: "برگشت از مشتری",
  staff_meal: "غذای کارکنان",
  other: "سایر",
};

export function WasteSection({ items, busy, run }: { items: InventoryItem[]; busy: boolean; run: Runner }) {
  const [entries, setEntries] = useState<WasteEntry[] | null>(null);
  const [inventoryItemId, setInventoryItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("spoilage");
  const [note, setNote] = useState("");

  const loadEntries = useCallback(() => {
    api<{ entries: WasteEntry[] }>("/api/inventory/waste").then(({ ok, data }) => {
      if (ok) setEntries(data.entries);
    });
  }, []);
  useEffect(loadEntries, [loadEntries]);

  const activeItems = items.filter((i) => i.is_active);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const qty = Number(quantity);
    if (!inventoryItemId || !Number.isFinite(qty) || qty <= 0) return;
    const ok = await run(() =>
      api("/api/inventory/waste", {
        method: "POST",
        body: JSON.stringify({ inventoryItemId, quantity: qty, reason, note }),
      }),
    );
    if (ok) {
      setQuantity("");
      setNote("");
      loadEntries();
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">ثبت ضایعات</h2>
        <p className="mb-3 text-xs text-stone-500">
          ضایعات مستقل از فروش است و تنها موجودی را کاهش می‌دهد؛ در ارقام فروش اثری ندارد.
        </p>
        <form onSubmit={submit} className="grid gap-2 sm:grid-cols-5">
          <select className={inputClass} value={inventoryItemId} onChange={(e) => setInventoryItemId(e.target.value)} required>
            <option value="">قلم انبار…</option>
            {activeItems.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.unit})
              </option>
            ))}
          </select>
          <input
            className={inputClass}
            dir="ltr"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="مقدار"
            required
          />
          <select className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)}>
            {Object.entries(REASON_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="یادداشت (اختیاری)" />
          <PrimaryButton disabled={busy}>ثبت ضایعات</PrimaryButton>
        </form>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">ضایعات اخیر</h2>
        <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
          {(entries ?? []).map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
              <span>
                {e.inventory_item_name} — {toPersianDigits(e.quantity)} {e.unit} ({REASON_LABELS[e.waste_reason] ?? e.waste_reason})
              </span>
              <span className="text-xs text-stone-400">
                {formatToman(Number(e.quantity) * Number(e.unit_cost))} — {formatJalali(e.occurred_at)}
              </span>
            </li>
          ))}
          {entries && entries.length === 0 ? <li className="p-3 text-sm text-stone-400">ضایعاتی ثبت نشده است.</li> : null}
        </ul>
      </section>
    </div>
  );
}
