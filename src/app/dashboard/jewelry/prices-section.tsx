"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, Field, inputClass } from "../ui";
import { PURITY_LABELS, type GoldPriceRow, type Purity, type Runner } from "./jewelry-manager";
import { cardClass } from "../page-chrome";

const jewelryInputClass = `${inputClass} min-h-[52px] !border-border !bg-card shadow-none placeholder:text-muted-foreground focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-amber-400/30 dark:focus-visible:ring-amber-400/40`;

export function PricesSection({ prices, busy, run }: { prices: GoldPriceRow[]; busy: boolean; run: Runner }) {
  const money = useMoney();
  const [purity, setPurity] = useState<Purity>("18");
  const [pricePerGram, setPricePerGram] = useState("");

  async function record(e: React.FormEvent) {
    e.preventDefault();
    if (!pricePerGram.trim()) return;
    const ok = await run(() =>
      api("/api/jewelry/prices", {
        method: "POST",
        body: JSON.stringify({ purity, pricePerGram: money.fromInput(Math.max(1, Math.round(Number(pricePerGram)))) }),
      }),
    );
    if (ok) setPricePerGram("");
  }

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_18rem] lg:gap-5 lg:grid-cols-[minmax(0,1fr)_21rem]">
      <section
        aria-labelledby="jewelry-prices-heading"
        className={`order-2 min-w-0 overflow-hidden ${cardClass} md:order-1`}
      >
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <h2 id="jewelry-prices-heading" className="font-semibold text-foreground">
            تابلوی نرخ روز طلا
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            آخرین نرخ ثبت‌شده هر عیار؛ لازم نیست هر روز دوباره ثبت شود، تا زمانی که نرخ جدیدی وارد نشده همین نرخ برای فروش استفاده می‌شود.
          </p>
        </div>

        <ul className="divide-y divide-border/80">
          {prices.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-4 px-4 py-4 sm:px-5">
              <div>
                <h3 className="font-semibold text-foreground">{PURITY_LABELS[p.purity]}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatJalali(p.priceDate, { withMonthName: true })}
                  {p.source === "external" ? " · دریافتی از سرویس بیرونی" : " · ثبت دستی"}
                </p>
              </div>
              <p className="font-semibold text-foreground">{money.format(p.pricePerGram)} / گرم</p>
            </li>
          ))}
          {prices.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">نرخی ثبت نشده است.</li>
          ) : null}
        </ul>
      </section>

      <aside className="order-1 min-w-0 md:order-2">
        <div className={`${cardClass} p-4 md:sticky md:top-4 sm:p-5`}>
          <h2 className="font-semibold text-foreground">ثبت نرخ امروز</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">نرخ هر گرم طلا ({money.unitLabel}) برای هر عیار جداگانه ثبت می‌شود.</p>

          <form onSubmit={record} className="mt-4">
            <Field label="عیار">
              <SearchableSelect
                className={jewelryInputClass}
                value={purity}
                onChange={(value) => setPurity(value as Purity)}
                options={(Object.keys(PURITY_LABELS) as Purity[]).map((p) => ({
                  value: p,
                  label: PURITY_LABELS[p],
                }))}
              />
            </Field>
            <Field label={`قیمت هر گرم (${money.unitLabel})`}>
              <PersianNumberInput
                className={jewelryInputClass}
                dir="ltr"
                inputMode="numeric"
                value={pricePerGram}
                onChange={(e) => setPricePerGram(e.target.value)}
                placeholder={toPersianDigits("مثلاً 4500000")}
                required
              />
            </Field>
            <Button
              type="submit"
              disabled={busy}
              size="lg"
              className="min-h-[52px] w-full border border-amber-300 dark:border-amber-500/40 px-5 font-semibold focus-visible:ring-amber-400/30 dark:focus-visible:ring-amber-400/40"
            >
              ثبت نرخ
            </Button>
          </form>
        </div>
      </aside>
    </div>
  );
}
