"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, Field, inputClass } from "../ui";
import type { Runner, VariantRow } from "./accessories-manager";
import { cardClass } from "../page-chrome";

const accInputClass = `${inputClass} min-h-[52px] !border-stone-200 !bg-card shadow-none placeholder:text-stone-400 focus-visible:border-amber-500 focus-visible:ring-amber-400/30`;
const secondaryActionClass =
  "min-h-[44px] border-stone-200 bg-card px-3 text-xs text-stone-700 hover:border-amber-300 hover:bg-amber-50 hover:text-stone-950 focus-visible:border-amber-500 focus-visible:ring-amber-400/30";

export function VariantsSection({
  items,
  busy,
  run,
  apiBase = "/api/accessories",
}: {
  items: VariantRow[];
  busy: boolean;
  run: Runner;
  /** The trade's own items API prefix — cosmetics reuses this same board with its own routes. */
  apiBase?: string;
}) {
  const families = items.filter((i) => i.kind === "variant_parent");

  const [familyName, setFamilyName] = useState("");
  const [parentItemId, setParentItemId] = useState("");
  const [variantName, setVariantName] = useState("");
  const [variantSku, setVariantSku] = useState("");
  const [attributes, setAttributes] = useState([{ name: "رنگ", value: "" }]);

  async function addFamily(e: React.FormEvent) {
    e.preventDefault();
    if (!familyName.trim()) return;
    const ok = await run(() =>
      api(`${apiBase}/items`, { method: "POST", body: JSON.stringify({ name: familyName }) }),
    );
    if (ok) setFamilyName("");
  }

  async function addVariant(e: React.FormEvent) {
    e.preventDefault();
    if (!parentItemId || !variantName.trim()) return;
    const ok = await run(() =>
      api(`${apiBase}/items`, {
        method: "POST",
        body: JSON.stringify({
          name: variantName,
          sku: variantSku.trim() || null,
          parentItemId,
          attributes: attributes.filter((a) => a.name.trim() && a.value.trim()),
        }),
      }),
    );
    if (ok) {
      setVariantName("");
      setVariantSku("");
      setAttributes([{ name: "رنگ", value: "" }]);
    }
  }

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_18rem] lg:gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
      <section
        aria-labelledby="accessories-items-heading"
        className={`order-2 min-w-0 overflow-hidden ${cardClass} md:order-1`}
      >
        <div className="border-b border-stone-200/80 px-4 py-4 sm:px-5">
          <h2 id="accessories-items-heading" className="font-semibold text-stone-950">
            خانواده‌ها و تنوع‌ها
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            هر تنوع موجودی و قیمت خودش را دارد؛ بهای تمام‌شده با هر ورود کالا به‌صورت میانگین موزون به‌روز می‌شود.
          </p>
        </div>

        <ul className="divide-y divide-stone-200/80">
          {items.map((item) => (
            <VariantRowView key={item.id} item={item} busy={busy} run={run} apiBase={apiBase} />
          ))}
          {items.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">کالایی ثبت نشده است.</li>
          ) : null}
        </ul>
      </section>

      <aside className="order-1 min-w-0 space-y-4 md:order-2">
        <div className={`${cardClass} p-4 sm:p-5`}>
          <h2 className="font-semibold text-stone-950">افزودن خانوادهٔ کالا</h2>
          <form onSubmit={addFamily} className="mt-4">
            <Field label="نام خانواده">
              <input
                className={accInputClass}
                value={familyName}
                onChange={(e) => setFamilyName(e.target.value)}
                placeholder="مثلاً دستبند بافت"
                required
              />
            </Field>
            <Button
              type="submit"
              disabled={busy}
              size="lg"
              className="min-h-[52px] w-full border border-amber-300 px-5 font-semibold focus-visible:ring-amber-400/30"
            >
              افزودن خانواده
            </Button>
          </form>
        </div>

        <div className={`${cardClass} p-4 sm:p-5`}>
          <h2 className="font-semibold text-stone-950">افزودن تنوع</h2>
          <form onSubmit={addVariant} className="mt-4">
            <Field label="خانواده">
              <SearchableSelect
                className={accInputClass}
                value={parentItemId}
                onChange={setParentItemId}
                options={families.map((f) => ({ value: f.id, label: f.name }))}
                placeholder="انتخاب خانواده"
              />
            </Field>
            <Field label="نام تنوع">
              <input
                className={accInputClass}
                value={variantName}
                onChange={(e) => setVariantName(e.target.value)}
                placeholder="مثلاً دستبند بافت — طلایی"
                required
              />
            </Field>
            <Field label="کد کالا">
              <input
                className={accInputClass}
                value={variantSku}
                onChange={(e) => setVariantSku(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>

            {attributes.map((attribute, index) => (
              <div key={index} className="grid grid-cols-2 gap-2">
                <Field label="ویژگی">
                  <input
                    className={accInputClass}
                    value={attribute.name}
                    onChange={(e) =>
                      setAttributes((current) =>
                        current.map((a, i) => (i === index ? { ...a, name: e.target.value } : a)),
                      )
                    }
                    placeholder="رنگ"
                  />
                </Field>
                <Field label="مقدار">
                  <input
                    className={accInputClass}
                    value={attribute.value}
                    onChange={(e) =>
                      setAttributes((current) =>
                        current.map((a, i) => (i === index ? { ...a, value: e.target.value } : a)),
                      )
                    }
                    placeholder="طلایی"
                  />
                </Field>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={`${secondaryActionClass} mb-4 w-full`}
              onClick={() => setAttributes((current) => [...current, { name: "", value: "" }])}
            >
              افزودن ویژگی دیگر
            </Button>

            <Button
              type="submit"
              disabled={busy || families.length === 0}
              size="lg"
              className="min-h-[52px] w-full border border-amber-300 px-5 font-semibold focus-visible:ring-amber-400/30"
            >
              افزودن تنوع
            </Button>
          </form>
        </div>
      </aside>
    </div>
  );
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-stone-500">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-stone-700">{children}</dd>
    </div>
  );
}

function VariantRowView({
  item,
  busy,
  run,
  apiBase,
}: {
  item: VariantRow;
  busy: boolean;
  run: Runner;
  apiBase: string;
}) {
  const money = useMoney();
  const [panel, setPanel] = useState<"stock" | null>(null);
  const toggle = (next: "stock") => setPanel((current) => (current === next ? null : next));
  const isFamily = item.kind === "variant_parent";

  return (
    <li className={`flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-5 ${isFamily ? "bg-stone-50/60" : ""}`}>
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="min-w-0 break-words font-semibold text-stone-950">{item.name}</h3>
            {item.sku ? <span className="text-xs text-muted-foreground">({item.sku})</span> : null}
            {isFamily ? (
              <span className="rounded-full bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-700">
                خانوادهٔ کالا
              </span>
            ) : null}
            {item.attributes.map((attribute) => (
              <span
                key={attribute.name}
                className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-950"
              >
                {attribute.name}: {attribute.value}
              </span>
            ))}
          </div>

          {!isFamily ? (
            <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-2 text-xs text-stone-600 sm:grid-cols-2 xl:grid-cols-4">
              <MetaItem label="موجودی">{formatQuantity(item.quantity)}</MetaItem>
              <MetaItem label="بهای تمام‌شده هر واحد">
                {item.unitCost != null ? money.format(item.unitCost) : "تعیین نشده"}
              </MetaItem>
              <MetaItem label="قیمت فروش">
                {item.unitPrice != null ? money.format(item.unitPrice) : "تعیین نشده"}
              </MetaItem>
            </dl>
          ) : null}
        </div>

        {!isFamily ? (
          <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryActionClass}
              disabled={busy}
              onClick={() => toggle("stock")}
            >
              ورود کالا / قیمت
            </Button>
            {Number(item.quantity) > 0 ? (
              // Selling happens on the invoice screen, the only place a sale
              // becomes a document (Phase 25 Wave 3). This page manages the
              // catalogue; it no longer offers a parallel way to sell straight
              // to the ledger.
              <Link
                href="/dashboard/pos"
                className="inline-flex min-h-[44px] items-center rounded-md border border-amber-300 bg-amber-100 px-3 text-xs font-semibold text-amber-950 transition-colors hover:bg-amber-200"
              >
                فروش در فاکتور
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>

      {panel === "stock" ? (
        <StockPanel item={item} busy={busy} run={run} apiBase={apiBase} onDone={() => setPanel(null)} />
      ) : null}
    </li>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl bg-amber-50/60 p-3 sm:p-4">{children}</div>;
}

function StockPanel({
  item,
  busy,
  run,
  apiBase,
  onDone,
}: {
  item: VariantRow;
  busy: boolean;
  run: Runner;
  apiBase: string;
  onDone: () => void;
}) {
  const money = useMoney();
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [unitPrice, setUnitPrice] = useState(item.unitPrice != null ? String(money.toInput(item.unitPrice)) : "");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() =>
      api(`${apiBase}/items/${item.id}/stock`, {
        method: "POST",
        body: JSON.stringify({
          quantity: quantity.trim() || undefined,
          unitCost: quantity.trim() ? money.fromInput(Math.max(0, Math.round(Number(unitCost || 0)))) : undefined,
          unitPrice: unitPrice.trim() ? money.fromInput(Math.max(0, Math.round(Number(unitPrice || 0)))) : undefined,
        }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <PanelShell>
      <form onSubmit={save} className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Field label="تعداد ورودی" hint="برای ثبت فقط قیمت، خالی بگذارید.">
          <PersianNumberInput
            className={accInputClass}
            dir="ltr"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
        <Field label={`بهای تمام‌شده هر واحد (${money.unitLabel})`}>
          <PersianNumberInput
            className={accInputClass}
            dir="ltr"
            inputMode="numeric"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
          />
        </Field>
        <Field label={`قیمت فروش هر واحد (${money.unitLabel})`}>
          <PersianNumberInput
            className={accInputClass}
            dir="ltr"
            inputMode="numeric"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
          />
        </Field>
        <div className="sm:col-span-3">
          <Button type="submit" disabled={busy} size="sm" className="min-h-[44px] border border-amber-300 px-5 font-semibold">
            ذخیره
          </Button>
        </div>
      </form>
    </PanelShell>
  );
}
