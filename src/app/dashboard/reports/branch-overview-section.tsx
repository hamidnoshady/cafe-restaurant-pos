"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Phase 14 — consolidated numbers across a business's own branches.
 *
 * Not the Phase 9 cross-server comparison (dashboard/locations): this reads
 * /api/reports/business-overview, which queries the same reporting views every
 * per-branch report already reads, so these numbers can never disagree with a
 * branch's own reports.
 */
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatMoney, type MoneyUnit } from "@/lib/money";
import { useMoney } from "@/components/money/money-context";
import { ErrorBox, api, errorMessage } from "../ui";

interface BranchRow {
  locationId: string;
  locationName: string;
  isActive: boolean;
  orderCount: number;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  cogs: number;
  wasteCost: number;
}

interface Overview {
  branches: BranchRow[];
  consolidated: Omit<BranchRow, "locationId" | "locationName" | "isActive">;
}

function money(value: number, unit: MoneyUnit = "toman"): string {
  return toPersianDigits(formatMoney(value, unit));
}

function BranchMetrics({ branch }: { branch: BranchRow }) {
  const moneyApi = useMoney();
  return (
    <dl className="grid grid-cols-2 gap-3">
      <div>
        <dt className="text-xs text-stone-500">تعداد سفارش</dt>
        <dd className="mt-1 font-bold tabular-nums text-stone-950">
          {toPersianDigits(String(branch.orderCount))}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-stone-500">فروش ناخالص</dt>
        <dd className="mt-1 font-bold tabular-nums text-stone-950">
          {money(branch.subtotal, moneyApi.unit)}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-stone-500">بهای تمام‌شده</dt>
        <dd className="mt-1 font-bold tabular-nums text-stone-950">
          {money(branch.cogs, moneyApi.unit)}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-stone-500">ضایعات</dt>
        <dd className="mt-1 font-bold tabular-nums text-stone-950">
          {money(branch.wasteCost, moneyApi.unit)}
        </dd>
      </div>
      <div className="col-span-2 border-t border-stone-100 pt-3">
        <dt className="text-xs text-stone-500">فروش خالص</dt>
        <dd className="mt-1 text-base font-bold tabular-nums text-stone-950">
          {money(branch.total, moneyApi.unit)}
        </dd>
      </div>
    </dl>
  );
}

export function BranchOverviewSection() {
  const moneyApi = useMoney();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const result = await api<Overview & { error?: string }>(
        "/api/reports/business-overview",
      );
      if (result.ok) setData(result.data);
      else setError(errorMessage(result.data.error));
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <SectionCardSkeleton rows={4} label="در حال بارگذاری مقایسه شعب" />
    );
  }

  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!data) return null;

  if (data.branches.length <= 1) {
    return (
      <section className="rounded-2xl border border-dashed border-stone-200/80 bg-stone-50 p-5 sm:p-6">
        <p className="text-xs font-semibold text-amber-700">مقایسهٔ شعب</p>
        <p className="mt-2 text-sm leading-6 text-stone-500">
          این کسب‌وکار بیش از یک شعبه ندارد؛ مقایسه وقتی شعبهٔ دوم اضافه شود در
          دسترس خواهد بود.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="branch-overview-heading"
      className="overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgb(41_37_36/0.03)]"
    >
      <header className="border-b border-stone-100 px-4 py-4 sm:px-5">
        <p className="text-xs font-semibold text-amber-700">نمای یکپارچه</p>
        <h2
          id="branch-overview-heading"
          className="mt-1 text-lg font-bold text-stone-950"
        >
          مقایسهٔ شعب
        </h2>
        <p className="mt-1 text-sm text-stone-500">
          اعداد تجمیعی بر پایهٔ گزارش‌های فعلی هر شعبه.
        </p>
      </header>

      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-[760px] w-full text-sm">
          <caption className="sr-only">مقایسه عملکرد شعب</caption>
          <thead className="bg-stone-50 text-stone-500">
            <tr className="border-b border-stone-200/80">
              <th
                scope="col"
                className="px-4 py-3.5 text-start text-xs font-semibold"
              >
                شعبه
              </th>
              <th
                scope="col"
                className="px-4 py-3.5 text-start text-xs font-semibold"
              >
                تعداد سفارش
              </th>
              <th
                scope="col"
                className="px-4 py-3.5 text-start text-xs font-semibold"
              >
                فروش ناخالص
              </th>
              <th
                scope="col"
                className="px-4 py-3.5 text-start text-xs font-semibold"
              >
                بهای تمام‌شده
              </th>
              <th
                scope="col"
                className="px-4 py-3.5 text-start text-xs font-semibold"
              >
                ضایعات
              </th>
              <th
                scope="col"
                className="px-4 py-3.5 text-start text-xs font-semibold"
              >
                فروش خالص
              </th>
            </tr>
          </thead>
          <tbody>
            {data.branches.map((branch) => (
              <tr
                key={branch.locationId}
                className="border-b border-stone-100 last:border-b-0"
              >
                <td className="px-4 py-4 font-semibold text-stone-950">
                  <span>{branch.locationName}</span>
                  {!branch.isActive ? (
                    <span className="ms-2 rounded-full bg-stone-100 px-2 py-1 text-xs font-medium text-stone-600">
                      غیرفعال
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-4 tabular-nums text-stone-950">
                  {toPersianDigits(String(branch.orderCount))}
                </td>
                <td className="px-4 py-4 tabular-nums text-stone-950">
                  {money(branch.subtotal, moneyApi.unit)}
                </td>
                <td className="px-4 py-4 tabular-nums text-stone-950">
                  {money(branch.cogs, moneyApi.unit)}
                </td>
                <td className="px-4 py-4 tabular-nums text-stone-950">
                  {money(branch.wasteCost, moneyApi.unit)}
                </td>
                <td className="px-4 py-4 font-bold tabular-nums text-stone-950">
                  {money(branch.total, moneyApi.unit)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-stone-50">
            <tr className="border-t-2 border-stone-200/80 font-bold text-stone-950">
              <th scope="row" className="px-4 py-4 text-start">
                مجموع کسب‌وکار
              </th>
              <td className="px-4 py-4 tabular-nums">
                {toPersianDigits(String(data.consolidated.orderCount))}
              </td>
              <td className="px-4 py-4 tabular-nums">
                {money(data.consolidated.subtotal, moneyApi.unit)}
              </td>
              <td className="px-4 py-4 tabular-nums">
                {money(data.consolidated.cogs, moneyApi.unit)}
              </td>
              <td className="px-4 py-4 tabular-nums">
                {money(data.consolidated.wasteCost, moneyApi.unit)}
              </td>
              <td className="px-4 py-4 tabular-nums">
                {money(data.consolidated.total, moneyApi.unit)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="space-y-3 p-4 md:hidden">
        {data.branches.map((branch) => (
          <article
            key={branch.locationId}
            className="rounded-xl border border-stone-200/80 bg-stone-50 p-4"
          >
            <div className="mb-4 flex items-start justify-between gap-3 border-b border-stone-100 pb-3">
              <h3 className="font-bold text-stone-950">
                {branch.locationName}
              </h3>
              {!branch.isActive ? (
                <span className="shrink-0 rounded-full bg-stone-100 px-2 py-1 text-xs font-medium text-stone-600">
                  غیرفعال
                </span>
              ) : null}
            </div>
            <BranchMetrics branch={branch} />
          </article>
        ))}

        <article className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
          <h3 className="mb-4 text-sm font-bold text-stone-950">
            مجموع کسب‌وکار
          </h3>
          <BranchMetrics
            branch={{
              locationId: "consolidated",
              locationName: "مجموع کسب‌وکار",
              isActive: true,
              ...data.consolidated,
            }}
          />
        </article>
      </div>
    </section>
  );
}
