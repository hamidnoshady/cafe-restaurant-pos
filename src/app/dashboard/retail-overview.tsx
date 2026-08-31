"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReactNode } from "react";

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
import { AlertTriangleIcon, BarChart3Icon, GemIcon, PackageIcon, ReceiptTextIcon, WrenchIcon } from "lucide-react";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { labelFor } from "@/lib/industry-profile";
import type { Industry } from "@/lib/industries";
import { PageHeader, cardClass } from "./page-chrome";

interface RetailOverview {
  today: { invoiceCount: number; total: string };
  stock: { inStock: number; lowStock: number };
  goldPrices: { purity: string; pricePerGram: number; priceDate: string }[];
  openRepairs: number;
}

interface NearExpiryRow {
  itemName: string;
  parentName: string | null;
  batchNumber: string;
  expiryDate: string | null;
  quantity: string;
  bucket: "expired" | "under30" | "under90";
}

const EXPIRY_BUCKET_LABELS: Record<NearExpiryRow["bucket"], string> = {
  expired: "منقضی",
  under30: "زیر ۳۰ روز",
  under90: "زیر ۹۰ روز",
};

const PURITY_LABELS: Record<string, string> = {
  "18": "۱۸ عیار",
  "21": "۲۱ عیار",
  "24": "۲۴ عیار",
};

export function RetailOverview({ industry }: { industry: Industry }) {
  const money = useMoney();
  const [data, setData] = useState<RetailOverview | null>(null);
  const [nearExpiry, setNearExpiry] = useState<NearExpiryRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const requests: Promise<void>[] = [
        fetch("/api/dashboard/retail-overview", { cache: "no-store" }).then(async (response) => {
          if (response.ok) setData((await response.json()) as RetailOverview);
        }),
      ];
      if (industry === "cosmetics") {
        requests.push(
          fetch("/api/cosmetics/reports/near-expiry", { cache: "no-store" }).then(async (response) => {
            if (response.ok) setNearExpiry(((await response.json()) as { rows: NearExpiryRow[] }).rows);
          }),
        );
      }
      await Promise.all(requests);
    } finally {
      setLoading(false);
    }
  }, [industry]);

  useEffect(() => {
    void load();
  }, [load]);

  const today = toPersianDigits(formatJalali(new Date(), { withMonthName: true }));

  return (
    <section className="w-full" aria-labelledby="retail-overview-heading">
      <PageHeader
        title={<span id="retail-overview-heading">داشبورد</span>}
        actions={<p className="text-sm text-muted-foreground">امروز: {today}</p>}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          icon={BarChart3Icon}
          label="فروش امروز"
          hint={`جمع ${labelFor(industry, "saleDocumentPlural")} تکمیل‌شده`}
          value={loading ? <Skeleton className="h-7 w-28" /> : money.format(Number(data?.today.total ?? 0))}
        />
        <Kpi
          icon={ReceiptTextIcon}
          label={`تعداد ${labelFor(industry, "saleDocument")}`}
          hint="امروز"
          value={loading ? <Skeleton className="h-7 w-20" /> : formatPersianNumber(data?.today.invoiceCount ?? 0)}
        />
        <Kpi
          icon={PackageIcon}
          label="کالای موجود"
          hint="آمادهٔ فروش در این شعبه"
          value={loading ? <Skeleton className="h-7 w-20" /> : formatPersianNumber(data?.stock.inStock ?? 0)}
        />
        {industry === "watch" ? (
          <Kpi
            icon={WrenchIcon}
            label="تعمیرات باز"
            hint="پذیرش‌شده و بسته‌نشده"
            value={loading ? <Skeleton className="h-7 w-20" /> : formatPersianNumber(data?.openRepairs ?? 0)}
          />
        ) : (
          <Kpi
            icon={PackageIcon}
            label="کالای ناموجود"
            hint="موجودی صفر — نیاز به ورود کالا"
            value={loading ? <Skeleton className="h-7 w-20" /> : formatPersianNumber(data?.stock.lowStock ?? 0)}
          />
        )}
      </div>

      {industry === "cosmetics" ? (
        <section className={`mb-5 ${cardClass} p-4 sm:p-5`}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold text-stone-950">
              <AlertTriangleIcon aria-hidden="true" className="size-4" />
              بچ‌های نزدیک به انقضا
            </h2>
            <Link href="/dashboard/cosmetics" className="text-sm font-semibold text-amber-800 hover:underline">
              مدیریت کالاها ←
            </Link>
          </div>
          {loading ? (
            <LoadingSkeleton rows={3} />
          ) : nearExpiry.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200/80 px-3 py-6 text-center text-sm text-stone-500">
              هیچ بچی منقضی یا نزدیک به انقضا نیست.
            </p>
          ) : (
            <ul className="divide-y divide-stone-200/80">
              {nearExpiry.slice(0, 10).map((row) => (
                <li key={`${row.batchNumber}-${row.itemName}`} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium text-stone-950">{row.itemName}</span>
                    <span className="mr-2 text-xs text-stone-500">
                      بچ {row.batchNumber}
                      {row.expiryDate ? ` · انقضا ${toPersianDigits(formatJalali(row.expiryDate))}` : ""}
                    </span>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      row.bucket === "expired"
                        ? "bg-rose-100 text-rose-800"
                        : row.bucket === "under30"
                          ? "bg-amber-100 text-amber-900"
                          : "bg-stone-100 text-stone-700"
                    }`}
                  >
                    {EXPIRY_BUCKET_LABELS[row.bucket]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {industry === "jewelry" ? (
        <section className={`mb-5 ${cardClass} p-4 sm:p-5`}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold text-stone-950">
              <GemIcon aria-hidden="true" className="size-4" />
              نرخ طلا
            </h2>
            <Link href="/dashboard/jewelry" className="text-sm font-semibold text-amber-800 hover:underline">
              ثبت نرخ روز ←
            </Link>
          </div>
          {loading ? (
            <LoadingSkeleton rows={3} />
          ) : data && data.goldPrices.length > 0 ? (
            <dl className="grid gap-3 sm:grid-cols-3">
              {data.goldPrices.map((price) => (
                <div key={price.purity} className="rounded-xl bg-stone-50 p-3">
                  <dt className="text-[11px] text-stone-500">
                    {PURITY_LABELS[price.purity] ?? price.purity} —{" "}
                    {toPersianDigits(formatJalali(price.priceDate))}
                  </dt>
                  <dd className="mt-1 text-sm font-bold text-stone-950">
                    {money.format(price.pricePerGram)} بر گرم
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
          className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl border border-amber-500/35 bg-amber-50 px-4 text-sm font-semibold text-amber-800 transition-colors hover:bg-amber-50"
        >
          {labelFor(industry, "sellScreen")} ←
        </Link>
        <Link
          href={`/dashboard/${industry}`}
          className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl border border-stone-200/80 bg-card px-4 text-sm font-semibold text-stone-600 transition-colors hover:bg-stone-50"
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
  value: ReactNode;
}) {
  return (
    <div className={`${cardClass} p-4 shadow-[0_1px_2px_rgb(41_37_36/0.03)]`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-stone-500">{label}</p>
          <p className="mt-1.5 text-xl font-bold text-stone-950">{value}</p>
          <p className="mt-1 text-[11px] text-stone-400">{hint}</p>
        </div>
        <span className="shrink-0 rounded-xl bg-amber-50 p-2 text-amber-700">
          <Icon aria-hidden="true" className="size-5" />
        </span>
      </div>
    </div>
  );
}
