"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { useMoney } from "@/components/money/money-context";
import { api } from "../ui";
import { cardClass } from "../page-chrome";

interface TrialBalanceRow {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  debit: string | number;
  credit: string | number;
}

interface TrialBalanceData {
  accounts: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

const TYPE_LABELS: Record<TrialBalanceRow["type"], string> = {
  asset: "دارایی",
  liability: "بدهی",
  equity: "حقوق صاحبان سرمایه",
  revenue: "درآمد",
  expense: "هزینه",
};

export function TrialBalanceSection({ refreshKey }: { refreshKey: number }) {
  const money = useMoney();
  const [data, setData] = useState<TrialBalanceData | null>(null);

  useEffect(() => {
    api<TrialBalanceData>("/api/ledger/trial-balance").then(({ ok, data }) => {
      if (ok) setData(data);
    });
  }, [refreshKey]);

  if (!data) {
    return (
      <SectionCardSkeleton rows={4} label="در حال بارگذاری تراز آزمایشی" />
    );
  }

  // Keep the API response as the financial source of truth. This UI only
  // removes entirely empty accounts from display, exactly as before.
  const rows = data.accounts.filter((a) => Number(a.debit) !== 0 || Number(a.credit) !== 0);

  return (
    <section
      aria-labelledby="trial-balance-heading"
      className={`${cardClass} p-4 shadow-[0_1px_2px_rgb(41_37_36/0.03)] sm:p-5`}
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-stone-100 pb-4">
        <div>
          <p className="mb-1 text-xs font-medium text-stone-500">گزارش مالی</p>
          <h2 id="trial-balance-heading" className="text-lg font-bold text-stone-950">
            تراز آزمایشی
          </h2>
          <p className="mt-1 text-sm text-stone-500">مانده حساب‌ها بر پایه اسناد ثبت‌شده</p>
        </div>
        <span
          className={`inline-flex min-h-8 items-center rounded-full px-3 text-xs font-bold ${
            data.balanced ? "bg-emerald-50 text-emerald-700" : "bg-destructive/10 text-destructive"
          }`}
        >
          <span aria-hidden="true" className={`me-1.5 size-2 rounded-full ${data.balanced ? "bg-emerald-500" : "bg-destructive"}`} />
          {data.balanced ? "متوازن" : "نامتوازن"}
        </span>
      </header>

      <div className="hidden overflow-hidden rounded-xl border border-stone-200/80 lg:block">
        <div className="overflow-x-auto">
          <table className="min-w-[680px] w-full text-sm">
            <thead className="bg-stone-50 text-stone-500">
              <tr className="border-b border-stone-200/80">
                <th scope="col" className="px-4 py-3.5 text-start text-xs font-semibold">
                  کد
                </th>
                <th scope="col" className="px-4 py-3.5 text-start text-xs font-semibold">
                  حساب
                </th>
                <th scope="col" className="px-4 py-3.5 text-start text-xs font-semibold">
                  نوع
                </th>
                <th scope="col" className="px-4 py-3.5 text-start text-xs font-semibold">
                  بدهکار
                </th>
                <th scope="col" className="px-4 py-3.5 text-start text-xs font-semibold">
                  بستانکار
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-b border-stone-100 last:border-b-0">
                  <td className="whitespace-nowrap px-4 py-4 font-medium text-stone-500">{a.code}</td>
                  <td className="px-4 py-4 font-semibold text-stone-950">{a.name}</td>
                  <td className="px-4 py-4 text-stone-500">{TYPE_LABELS[a.type]}</td>
                  <td className="whitespace-nowrap px-4 py-4 font-medium text-stone-950">
                    {money.format(Number(a.debit))}
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 font-medium text-stone-950">
                    {money.format(Number(a.credit))}
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-stone-500">
                    هنوز سندی ثبت نشده است.
                  </td>
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-stone-200/80 bg-stone-50 text-stone-950">
                <th scope="row" className="px-4 py-4 text-start font-bold" colSpan={3}>
                  جمع کل
                </th>
                <td className="whitespace-nowrap px-4 py-4 font-bold">{money.format(data.totalDebit)}</td>
                <td className="whitespace-nowrap px-4 py-4 font-bold">{money.format(data.totalCredit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="space-y-3 lg:hidden">
        {rows.map((a) => (
          <article key={a.id} className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-stone-500">{a.code}</p>
                <h3 className="mt-1 truncate font-bold text-stone-950">{a.name}</h3>
              </div>
              <span className="shrink-0 rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
                {TYPE_LABELS[a.type]}
              </span>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-stone-100 pt-3">
              <div className="rounded-lg bg-stone-50 px-3 py-2.5">
                <dt className="text-xs text-stone-500">بدهکار</dt>
                <dd className="mt-1 whitespace-nowrap text-sm font-bold text-stone-950">
                  {money.format(Number(a.debit))}
                </dd>
              </div>
              <div className="rounded-lg bg-stone-50 px-3 py-2.5">
                <dt className="text-xs text-stone-500">بستانکار</dt>
                <dd className="mt-1 whitespace-nowrap text-sm font-bold text-stone-950">
                  {money.format(Number(a.credit))}
                </dd>
              </div>
            </dl>
          </article>
        ))}
        {rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-10 text-center text-sm text-stone-500">
            هنوز سندی ثبت نشده است.
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-3 rounded-xl border border-stone-200/80 bg-stone-50 p-4">
          <div>
            <dt className="text-xs font-medium text-stone-500">جمع کل بدهکار</dt>
            <dd className="mt-1 whitespace-nowrap text-sm font-bold text-stone-950">{money.format(data.totalDebit)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-stone-500">جمع کل بستانکار</dt>
            <dd className="mt-1 whitespace-nowrap text-sm font-bold text-stone-950">{money.format(data.totalCredit)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
