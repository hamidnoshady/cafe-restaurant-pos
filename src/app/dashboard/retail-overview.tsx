"use client";

/**
 * Phase 25 Wave 4 — the retail industries' dashboard home.
 *
 * `OperationsOverview` is F&B's: open order tickets, a «میز / نوع» column and
 * kitchen statuses. A shop has none of those, so it rendered a permanently
 * empty table under the heading «سفارش‌های فعال» — the clearest remaining sign
 * that the product still thought every business was a café.
 *
 * This shows what a shop counter actually wants: today's takings, what is
 * sellable right now, and the one number that changes daily for its trade.
 * It reads `/api/dashboard/retail-overview`, whose queries are the retail
 * counterpart of the F&B overview's.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BarChart3Icon, GemIcon, PackageIcon, ReceiptTextIcon, WrenchIcon } from "lucide-react";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatToman } from "@/lib/money";
import { labelFor } from "@/lib/industry-profile";
import type { Industry } from "@/lib/industries";

interface RetailOverview {
  today: { invoiceCount: number; total: string };
  stock: { inStock: number; lowStock: number };
  goldPrices: { purity: string; pricePerGram: number; priceDate: string }[];
  openRepairs: number;
}

const PURITY_LABELS: Record<string, string> = {
  "18": "۱۸ عیار",
  "21": "۲۱ عیار",
  "24": "۲۴ عیار",
};

export function RetailOverview({ industry }: { industry: Industry }) {
  const [data, setData] = useState<RetailOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/dashboard/retail-overview", { cache: "no-store" });
      if (response.ok) setData((await response.json()) as RetailOverview);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const today = toPersianDigits(formatJalali(new Date(), { withMonthName: true }));

  return (
    <section className="w-full" aria-labelledby="retail-overview-heading">
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-2 border-b border-[#EAE8E2] pb-4">
        <h1 id="retail-overview-heading" className="text-2xl font-bold text-[#252522]">
          داشبورد
        </h1>
        <p className="text-sm text-[#77756F]">امروز: {today}</p>
      </header>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          icon={BarChart3Icon}
          label="فروش امروز"
          hint={`جمع ${labelFor(industry, "saleDocumentPlural")} تکمیل‌شده`}
          value={loading ? "…" : formatToman(Number(data?.today.total ?? 0))}
        />
        <Kpi
          icon={ReceiptTextIcon}
          label={`تعداد ${labelFor(industry, "saleDocument")}`}
          hint="امروز"
          value={loading ? "…" : formatPersianNumber(data?.today.invoiceCount ?? 0)}
        />
        <Kpi
          icon={PackageIcon}
          label="کالای موجود"
          hint="آمادهٔ فروش در این شعبه"
          value={loading ? "…" : formatPersianNumber(data?.stock.inStock ?? 0)}
        />
        {industry === "watch" ? (
          <Kpi
            icon={WrenchIcon}
            label="تعمیرات باز"
            hint="پذیرش‌شده و بسته‌نشده"
            value={loading ? "…" : formatPersianNumber(data?.openRepairs ?? 0)}
          />
        ) : (
          <Kpi
            icon={PackageIcon}
            label="کالای ناموجود"
            hint="موجودی صفر — نیاز به ورود کالا"
            value={loading ? "…" : formatPersianNumber(data?.stock.lowStock ?? 0)}
          />
        )}
      </div>

      {industry === "jewelry" ? (
        <section className="mb-5 rounded-2xl border border-[#EAE8E2] bg-white p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold text-[#252522]">
              <GemIcon aria-hidden="true" className="size-4" />
              نرخ طلا
            </h2>
            <Link href="/dashboard/jewelry" className="text-sm font-semibold text-[#8C5B00] hover:underline">
              ثبت نرخ روز ←
            </Link>
          </div>
          {loading ? (
            <p className="text-sm text-[#77756F]">در حال بارگذاری…</p>
          ) : data && data.goldPrices.length > 0 ? (
            <dl className="grid gap-3 sm:grid-cols-3">
              {data.goldPrices.map((price) => (
                <div key={price.purity} className="rounded-xl bg-[#FCFCFA] p-3">
                  <dt className="text-[11px] text-[#77756F]">
                    {PURITY_LABELS[price.purity] ?? price.purity} —{" "}
                    {toPersianDigits(formatJalali(price.priceDate))}
                  </dt>
                  <dd className="mt-1 text-sm font-bold text-[#252522]">
                    {formatPersianNumber(price.pricePerGram)} ریال بر گرم
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            // Without a rate for today, `sellWeightedItem` refuses every sale —
            // so this is the one thing that must be obvious on the home page.
            <p className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
              نرخ طلا هنوز ثبت نشده است. تا زمانی که نرخ روز ثبت نشود، فروش ممکن نیست.
            </p>
          )}
        </section>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Link
          href="/dashboard/pos"
          className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl border border-[#E9A11B]/35 bg-[#FFF9EE] px-4 text-sm font-semibold text-[#8C5B00] transition-colors hover:bg-[#FFF3DE]"
        >
          {labelFor(industry, "sellScreen")} ←
        </Link>
        <Link
          href={`/dashboard/${industry}`}
          className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl border border-[#EAE8E2] bg-white px-4 text-sm font-semibold text-[#52504B] transition-colors hover:bg-[#FCFCFA]"
        >
          مدیریت {labelFor(industry, "catalogue")} ←
        </Link>
      </div>
    </section>
  );
}

function Kpi({
  icon: Icon,
  label,
  hint,
  value,
}: {
  icon: typeof BarChart3Icon;
  label: string;
  hint: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-[#EAE8E2] bg-white p-4 shadow-[0_1px_2px_rgba(37,37,34,0.03)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[#77756F]">{label}</p>
          <p className="mt-1.5 text-xl font-bold text-[#252522]">{value}</p>
          <p className="mt-1 text-[11px] text-[#9C9A94]">{hint}</p>
        </div>
        <span className="shrink-0 rounded-xl bg-[#FFF9EE] p-2 text-[#B97905]">
          <Icon aria-hidden="true" className="size-5" />
        </span>
      </div>
    </div>
  );
}
