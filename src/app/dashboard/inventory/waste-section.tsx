"use client";

import { useCallback, useEffect, useState } from "react";
import { formatQuantity } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { formatJalali } from "@/lib/jalali";
import { api, Field, inputClass, PrimaryButton } from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
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
    // Send the typed quantity as text — the server validates it and costs it
    // in exact decimal, so it must not lose precision through a double here.
    const qty = quantity.trim();
    if (!inventoryItemId || !Number.isFinite(Number(qty)) || Number(qty) <= 0) return;
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
      <section className="min-w-0 rounded-2xl border border-stone-200/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-5">
        <h2 className="mb-3 font-semibold">ثبت ضایعات</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          ضایعات مستقل از فروش است و تنها موجودی را کاهش می‌دهد؛ در ارقام فروش اثری ندارد.
        </p>
        <form onSubmit={submit} className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Field label="قلم انبار">
            <SearchableSelect
              value={inventoryItemId}
              onChange={setInventoryItemId}
              options={[
                { value: "", label: "قلم انبار را انتخاب کنید…" },
                ...activeItems.map((i) => ({
                  value: i.id,
                  label: `${i.name} (${i.unit})`,
                  searchString: [i.name, i.sku, i.unit].filter(Boolean).join(" "),
                })),
              ]}
            />
          </Field>
          <Field label="مقدار">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
          </Field>
          <Field label="دلیل ضایعات">
            <SearchableSelect
              value={reason}
              onChange={setReason}
              options={Object.entries(REASON_LABELS).map(([key, label]) => ({ value: key, label }))}
            />
          </Field>
          <Field label="یادداشت">
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="اختیاری" />
          </Field>
          <div className="mb-4 flex items-end">
            <PrimaryButton disabled={busy}>ثبت ضایعات</PrimaryButton>
          </div>
        </form>
      </section>

      <section className="min-w-0 rounded-2xl border border-stone-200/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-5">
        <h2 className="mb-3 font-semibold">ضایعات اخیر</h2>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {(entries ?? []).map((e) => (
            <li key={e.id} className="flex min-w-0 flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 break-words">
                {e.inventory_item_name} — {formatQuantity(e.quantity)} {e.unit} ({REASON_LABELS[e.waste_reason] ?? e.waste_reason})
              </span>
              <span className="text-xs text-muted-foreground">
                {formatToman(Number(e.quantity) * Number(e.unit_cost))} — {formatJalali(e.occurred_at)}
              </span>
            </li>
          ))}
          {entries && entries.length === 0 ? <li className="p-3 text-sm text-muted-foreground">ضایعاتی ثبت نشده است.</li> : null}
        </ul>
      </section>
    </div>
  );
}
