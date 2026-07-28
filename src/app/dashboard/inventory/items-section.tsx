"use client";

import { useState } from "react";
import { formatQuantity } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { api, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import type { InventoryItem, Runner } from "./inventory-manager";

export function ItemsSection({ items, busy, run }: { items: InventoryItem[]; busy: boolean; run: Runner }) {
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [reorderLevel, setReorderLevel] = useState("");
  const [purchaseUnit, setPurchaseUnit] = useState("");
  const [purchaseFactor, setPurchaseFactor] = useState("1");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !unit.trim()) return;
    const ok = await run(() =>
      api("/api/inventory/items", {
        method: "POST",
        body: JSON.stringify({
          name,
          unit,
          reorderLevel: reorderLevel.trim() ? Number(reorderLevel) : null,
          purchaseUnit: purchaseUnit.trim() || null,
          purchaseUnitFactor: purchaseFactor.trim() ? Number(purchaseFactor) : 1,
        }),
      }),
    );
    if (ok) {
      setName("");
      setUnit("");
      setReorderLevel("");
      setPurchaseUnit("");
      setPurchaseFactor("1");
    }
  }

  return (
    <section className="rounded-2xl bg-card p-5 shadow-sm">
      <h2 className="mb-3 font-semibold">اقلام انبار (مواد اولیه)</h2>
      <form onSubmit={add} className="mb-4 grid gap-2 sm:grid-cols-6">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="نام (مثلاً قهوه)" required />
        <input className={inputClass} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="واحد پایه (g، ml، عدد…)" required />
        <input
          className={inputClass}
          dir="ltr"
          inputMode="decimal"
          value={reorderLevel}
          onChange={(e) => setReorderLevel(e.target.value)}
          placeholder="آستانه سفارش مجدد"
        />
        <input
          className={inputClass}
          value={purchaseUnit}
          onChange={(e) => setPurchaseUnit(e.target.value)}
          placeholder="واحد خرید (اختیاری، مثلاً kg)"
        />
        <input
          className={inputClass}
          dir="ltr"
          inputMode="decimal"
          value={purchaseFactor}
          onChange={(e) => setPurchaseFactor(e.target.value)}
          placeholder="۱ واحد خرید = چند واحد پایه"
        />
        <PrimaryButton disabled={busy}>افزودن</PrimaryButton>
      </form>

      <ul className="divide-y divide-border rounded-lg border border-border">
        {items.map((it) => (
          <ItemRow key={it.id} item={it} busy={busy} run={run} />
        ))}
        {items.length === 0 ? <li className="p-3 text-sm text-muted-foreground">قلمی ثبت نشده است.</li> : null}
      </ul>
    </section>
  );
}

function ItemRow({ item, busy, run }: { item: InventoryItem; busy: boolean; run: Runner }) {
  const [editing, setEditing] = useState(false);
  const reorderLevel = item.reorder_level === null ? null : Number(item.reorder_level);
  const isLow = reorderLevel !== null && item.stock <= reorderLevel;

  if (editing) {
    return <EditItemRow item={item} busy={busy} run={run} onDone={() => setEditing(false)} />;
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
      <span className={item.is_active ? "" : "text-muted-foreground line-through"}>
        {item.name}
        {item.sku ? <span className="text-xs text-muted-foreground"> ({item.sku})</span> : null}
      </span>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className={isLow ? "font-semibold text-primary" : ""}>
          موجودی: {formatQuantity(item.stock)} {item.unit}
        </span>
        <span>میانگین بها: {formatToman(Number(item.avg_cost))}</span>
        {item.purchase_unit ? (
          <span>
            خرید: {item.purchase_unit} = {formatQuantity(item.purchase_unit_factor)} {item.unit}
          </span>
        ) : null}
        <SecondaryButton disabled={busy} onClick={() => setEditing(true)}>
          ویرایش
        </SecondaryButton>
        <SecondaryButton
          disabled={busy}
          onClick={() =>
            run(() =>
              api(`/api/inventory/items/${item.id}`, {
                method: "PATCH",
                body: JSON.stringify({ isActive: !item.is_active }),
              }),
            )
          }
        >
          {item.is_active ? "غیرفعال" : "فعال"}
        </SecondaryButton>
      </div>
    </li>
  );
}

function EditItemRow({
  item,
  busy,
  run,
  onDone,
}: {
  item: InventoryItem;
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [unit, setUnit] = useState(item.unit);
  const [reorderLevel, setReorderLevel] = useState(
    item.reorder_level === null ? "" : String(Number(item.reorder_level)),
  );
  const [purchaseUnit, setPurchaseUnit] = useState(item.purchase_unit ?? "");
  const [purchaseFactor, setPurchaseFactor] = useState(String(Number(item.purchase_unit_factor)));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !unit.trim()) return;
    const ok = await run(() =>
      api(`/api/inventory/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          unit,
          reorderLevel: reorderLevel.trim() ? Number(reorderLevel) : null,
          purchaseUnit: purchaseUnit.trim() || null,
          purchaseUnitFactor: purchaseFactor.trim() ? Number(purchaseFactor) : 1,
        }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <li className="px-4 py-3">
      <form onSubmit={save} className="grid gap-2 sm:grid-cols-6">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="نام" required />
        <input
          className={inputClass}
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="واحد پایه (g، ml، عدد…)"
          required
        />
        <input
          className={inputClass}
          dir="ltr"
          inputMode="decimal"
          value={reorderLevel}
          onChange={(e) => setReorderLevel(e.target.value)}
          placeholder="آستانه سفارش مجدد"
        />
        <input
          className={inputClass}
          value={purchaseUnit}
          onChange={(e) => setPurchaseUnit(e.target.value)}
          placeholder="واحد خرید (اختیاری، مثلاً kg)"
        />
        <input
          className={inputClass}
          dir="ltr"
          inputMode="decimal"
          value={purchaseFactor}
          onChange={(e) => setPurchaseFactor(e.target.value)}
          placeholder="۱ واحد خرید = چند واحد پایه"
        />
        <div className="flex gap-2 sm:col-span-6">
          <PrimaryButton disabled={busy}>ذخیره</PrimaryButton>
          <SecondaryButton disabled={busy} onClick={onDone}>
            انصراف
          </SecondaryButton>
        </div>
      </form>
    </li>
  );
}
