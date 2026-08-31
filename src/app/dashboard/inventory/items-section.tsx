"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useDeferredValue, useMemo, useState } from "react";
import { SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatQuantity } from "@/lib/digits";
import { useInventorySearch } from "@/lib/inventory-search";
import { useMoney } from "@/components/money/money-context";
import { api, Field, inputClass } from "../ui";
import type { InventoryItem, Runner } from "./inventory-manager";
import { cardClass } from "../page-chrome";

const inventoryInputClass = `${inputClass} min-h-[52px] !border-stone-200 !bg-card shadow-none placeholder:text-stone-400 focus-visible:border-amber-500 focus-visible:ring-amber-400/30`;
const secondaryActionClass =
  "min-h-[52px] border-stone-200 bg-card px-4 text-stone-700 hover:border-amber-300 hover:bg-amber-50 hover:text-stone-950 focus-visible:border-amber-500 focus-visible:ring-amber-400/30";

export function ItemsSection({
  items,
  busy,
  run,
}: {
  items: InventoryItem[];
  busy: boolean;
  run: Runner;
}) {
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [reorderLevel, setReorderLevel] = useState("");
  const [purchaseUnit, setPurchaseUnit] = useState("");
  const [purchaseFactor, setPurchaseFactor] = useState("1");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const visibleItems = useInventorySearch(items, deferredQuery);

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
          purchaseUnitFactor: purchaseFactor.trim()
            ? Number(purchaseFactor)
            : 1,
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
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_18rem] lg:gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
      <section
        aria-labelledby="inventory-items-heading"
        className={`order-2 min-w-0 overflow-hidden ${cardClass} md:order-1`}
      >
        <div className="border-b border-stone-200/80 px-4 py-4 sm:px-5">
          <h2
            id="inventory-items-heading"
            className="font-semibold text-stone-950"
          >
            اقلام انبار (مواد اولیه)
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            فهرست مواد اولیه و تنظیمات واحدهای خرید آن‌ها.
          </p>
          <div className="relative mt-3">
            <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className={`${inventoryInputClass} ps-9`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="جستجوی قلم (نام، کد، واحد)…"
              aria-label="جستجوی قلم انبار"
            />
          </div>
        </div>

        <ul className="divide-y divide-stone-200/80">
          {visibleItems.map((it) => (
            <ItemRow key={it.id} item={it} busy={busy} run={run} />
          ))}
          {items.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">
              قلمی ثبت نشده است.
            </li>
          ) : visibleItems.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">
              موردی یافت نشد.
            </li>
          ) : null}
        </ul>
      </section>

      <aside className="order-1 min-w-0 md:order-2">
        <div className={`${cardClass} p-4 md:sticky md:top-4 sm:p-5`}>
          <h2 className="font-semibold text-stone-950">افزودن قلم انبار</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            اطلاعات پایهٔ قلم را وارد کنید؛ آستانه سفارش مجدد اختیاری است.
          </p>

          <form onSubmit={add} className="mt-4">
            <Field label="نام قلم">
              <input
                className={inventoryInputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثلاً قهوه"
                required
              />
            </Field>
            <Field label="واحد پایه">
              <input
                className={inventoryInputClass}
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="g، ml، عدد…"
                required
              />
            </Field>
            <Field label="آستانه سفارش مجدد">
              <PersianNumberInput
                className={inventoryInputClass}
                dir="ltr"
                inputMode="decimal"
                value={reorderLevel}
                onChange={(e) => setReorderLevel(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Field label="واحد خرید">
              <input
                className={inventoryInputClass}
                value={purchaseUnit}
                onChange={(e) => setPurchaseUnit(e.target.value)}
                placeholder="اختیاری؛ مثلاً kg"
              />
            </Field>
            <Field label="ضریب تبدیل واحد خرید">
              <PersianNumberInput
                className={inventoryInputClass}
                dir="ltr"
                inputMode="decimal"
                value={purchaseFactor}
                onChange={(e) => setPurchaseFactor(e.target.value)}
                placeholder="مثلاً ۱۰۰۰"
              />
            </Field>
            <Button
              type="submit"
              disabled={busy}
              size="lg"
              className="min-h-[52px] w-full border border-amber-300 px-5 font-semibold focus-visible:ring-amber-400/30"
            >
              افزودن
            </Button>
          </form>
        </div>
      </aside>
    </div>
  );
}

function ItemRow({
  item,
  busy,
  run,
}: {
  item: InventoryItem;
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [editing, setEditing] = useState(false);
  const reorderLevel =
    item.reorder_level === null ? null : Number(item.reorder_level);

  if (editing) {
    return (
      <EditItemRow
        item={item}
        busy={busy}
        run={run}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <li className="flex min-w-0 flex-col gap-4 px-4 py-4 sm:px-5 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3
            className={`min-w-0 break-words font-semibold text-stone-950 ${item.is_active ? "" : "text-muted-foreground line-through"}`}
          >
            {item.name}
          </h3>
          {item.sku ? (
            <span className="text-xs text-muted-foreground">({item.sku})</span>
          ) : null}
          {/*
            Not editable here, by design: the flag is set when a production
            formula names this item as its output, so a checkbox could only
            ever contradict the formulas that actually exist.
          */}
          {item.is_produced ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[0.7rem] font-medium text-amber-950">
              ساخت داخلی
            </span>
          ) : null}
          {!item.is_active ? <span className="sr-only">غیرفعال</span> : null}
        </div>

        <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-2 text-xs text-stone-600 sm:grid-cols-2 xl:grid-cols-3">
          <MetaItem label="واحد پایه">{item.unit}</MetaItem>
          {reorderLevel !== null ? (
            <MetaItem label="آستانه سفارش مجدد">
              {formatQuantity(reorderLevel)} {item.unit}
            </MetaItem>
          ) : null}
          {item.purchase_unit ? (
            <MetaItem label="واحد خرید">
              {item.purchase_unit} = {formatQuantity(item.purchase_unit_factor)}{" "}
              {item.unit}
            </MetaItem>
          ) : null}
          <MetaItem label="موجودی فعلی">
            {formatQuantity(item.stock)} {item.unit}
          </MetaItem>
          <MetaItem label="میانگین بها">
            {money.format(Number(item.avg_cost))}
          </MetaItem>
        </dl>
      </div>

      <div className="grid shrink-0 grid-cols-1 gap-2 sm:flex sm:flex-wrap lg:justify-end">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className={secondaryActionClass}
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          ویرایش
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className={secondaryActionClass}
          disabled={busy}
          onClick={() =>
            void run(() =>
              api(`/api/inventory/items/${item.id}`, {
                method: "PATCH",
                body: JSON.stringify({ isActive: !item.is_active }),
              }),
            )
          }
        >
          {item.is_active ? "غیرفعال" : "فعال"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-h-[52px] border-destructive/25 bg-card px-4 text-destructive hover:border-destructive/40 hover:bg-destructive/5 focus-visible:border-destructive/40 focus-visible:ring-destructive/20"
          disabled={busy}
          onClick={() => {
            if (
              !window.confirm(
                `قلم «${item.name}» حذف شود؟ قلمی که سابقهٔ مصرف یا خرید دارد غیرفعال می‌شود.`,
              )
            )
              return;
            void run(() =>
              api(`/api/inventory/items/${item.id}`, { method: "DELETE" }),
            );
          }}
        >
          حذف
        </Button>
      </div>
    </li>
  );
}

function MetaItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-stone-500">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-stone-700">
        {children}
      </dd>
    </div>
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
  const [purchaseFactor, setPurchaseFactor] = useState(
    String(Number(item.purchase_unit_factor)),
  );

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
          purchaseUnitFactor: purchaseFactor.trim()
            ? Number(purchaseFactor)
            : 1,
        }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <li className="bg-amber-50/50 px-4 py-4 sm:px-5">
      <form
        onSubmit={save}
        className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5"
      >
        <Field label="نام قلم">
          <input
            className={inventoryInputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label="واحد پایه">
          <input
            className={inventoryInputClass}
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            required
          />
        </Field>
        <Field label="آستانه سفارش مجدد">
          <PersianNumberInput
            className={inventoryInputClass}
            dir="ltr"
            inputMode="decimal"
            value={reorderLevel}
            onChange={(e) => setReorderLevel(e.target.value)}
            placeholder="اختیاری"
          />
        </Field>
        <Field label="واحد خرید">
          <input
            className={inventoryInputClass}
            value={purchaseUnit}
            onChange={(e) => setPurchaseUnit(e.target.value)}
            placeholder="اختیاری؛ مثلاً kg"
          />
        </Field>
        <Field label="ضریب تبدیل واحد خرید">
          <PersianNumberInput
            className={inventoryInputClass}
            dir="ltr"
            inputMode="decimal"
            value={purchaseFactor}
            onChange={(e) => setPurchaseFactor(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row xl:col-span-5">
          <Button
            type="submit"
            disabled={busy}
            size="lg"
            className="min-h-[52px] w-full border border-amber-300 px-5 font-semibold focus-visible:ring-amber-400/30 sm:w-40"
          >
            ذخیره
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className={secondaryActionClass}
            disabled={busy}
            onClick={onDone}
          >
            انصراف
          </Button>
        </div>
      </form>
    </li>
  );
}
