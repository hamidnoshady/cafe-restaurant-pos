"use client";

import { useEffect, useState } from "react";
import { formatToman } from "@/lib/money";
import { api } from "../ui";

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
  const [data, setData] = useState<TrialBalanceData | null>(null);

  useEffect(() => {
    api<TrialBalanceData>("/api/ledger/trial-balance").then(({ ok, data }) => {
      if (ok) setData(data);
    });
  }, [refreshKey]);

  if (!data) {
    return (
      <section
        aria-live="polite"
        aria-label="در حال بارگذاری تراز آزمایشی"
        className="rounded-2xl border border-[#EAE8E2] bg-white px-5 py-6 text-sm text-[#77756F] shadow-[0_1px_2px_rgb(41_37_36/0.03)]"
      >
        در حال بارگذاری…
      </section>
    );
  }

  // Keep the API response as the financial source of truth. This UI only
  // removes entirely empty accounts from display, exactly as before.
  const rows = data.accounts.filter((a) => Number(a.debit) !== 0 || Number(a.credit) !== 0);

  return (
    <section
      aria-labelledby="trial-balance-heading"
      className="rounded-2xl border border-[#EAE8E2] bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.03)] sm:p-5"
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-[#F0EEE9] pb-4">
        <div>
          <p className="mb-1 text-xs font-medium text-[#77756F]">گزارش مالی</p>
          <h2 id="trial-balance-heading" className="text-lg font-bold text-[#252522]">
            تراز آزمایشی
          </h2>
          <p className="mt-1 text-sm text-[#77756F]">مانده حساب‌ها بر پایه اسناد ثبت‌شده</p>
        </div>
        <span
          className={`inline-flex min-h-8 items-center rounded-full px-3 text-xs font-bold ${
            data.balanced ? "bg-[#E7F6EC] text-[#1E7A45]" : "bg-[#FDECEC] text-[#B42318]"
          }`}
        >
          <span aria-hidden="true" className={`me-1.5 size-2 rounded-full ${data.balanced ? "bg-[#36B56A]" : "bg-[#D95757]"}`} />
          {data.balanced ? "متوازن" : "نامتوازن"}
        </span>
      </header>

      <div className="hidden overflow-hidden rounded-xl border border-[#EEECE7] lg:block">
        <div className="overflow-x-auto">
          <table className="min-w-[680px] w-full text-sm">
            <thead className="bg-[#FCFBF8] text-[#77756F]">
              <tr className="border-b border-[#EEECE7]">
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
                <tr key={a.id} className="border-b border-[#F0EEE9] last:border-b-0">
                  <td className="whitespace-nowrap px-4 py-4 font-medium text-[#77756F]">{a.code}</td>
                  <td className="px-4 py-4 font-semibold text-[#252522]">{a.name}</td>
                  <td className="px-4 py-4 text-[#77756F]">{TYPE_LABELS[a.type]}</td>
                  <td className="whitespace-nowrap px-4 py-4 font-medium text-[#252522]">
                    {formatToman(Number(a.debit))}
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 font-medium text-[#252522]">
                    {formatToman(Number(a.credit))}
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-[#77756F]">
                    هنوز سندی ثبت نشده است.
                  </td>
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[#DEDAD2] bg-[#FCFBF8] text-[#252522]">
                <th scope="row" className="px-4 py-4 text-start font-bold" colSpan={3}>
                  جمع کل
                </th>
                <td className="whitespace-nowrap px-4 py-4 font-bold">{formatToman(data.totalDebit)}</td>
                <td className="whitespace-nowrap px-4 py-4 font-bold">{formatToman(data.totalCredit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="space-y-3 lg:hidden">
        {rows.map((a) => (
          <article key={a.id} className="rounded-xl border border-[#EEECE7] bg-[#FFFEFC] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-[#77756F]">{a.code}</p>
                <h3 className="mt-1 truncate font-bold text-[#252522]">{a.name}</h3>
              </div>
              <span className="shrink-0 rounded-full bg-[#F5F3EE] px-2.5 py-1 text-xs font-medium text-[#5E5B55]">
                {TYPE_LABELS[a.type]}
              </span>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-[#F0EEE9] pt-3">
              <div className="rounded-lg bg-[#FCFBF8] px-3 py-2.5">
                <dt className="text-xs text-[#77756F]">بدهکار</dt>
                <dd className="mt-1 whitespace-nowrap text-sm font-bold text-[#252522]">
                  {formatToman(Number(a.debit))}
                </dd>
              </div>
              <div className="rounded-lg bg-[#FCFBF8] px-3 py-2.5">
                <dt className="text-xs text-[#77756F]">بستانکار</dt>
                <dd className="mt-1 whitespace-nowrap text-sm font-bold text-[#252522]">
                  {formatToman(Number(a.credit))}
                </dd>
              </div>
            </dl>
          </article>
        ))}
        {rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[#DEDAD2] bg-[#FCFBF8] px-4 py-10 text-center text-sm text-[#77756F]">
            هنوز سندی ثبت نشده است.
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-3 rounded-xl border border-[#DEDAD2] bg-[#FCFBF8] p-4">
          <div>
            <dt className="text-xs font-medium text-[#77756F]">جمع کل بدهکار</dt>
            <dd className="mt-1 whitespace-nowrap text-sm font-bold text-[#252522]">{formatToman(data.totalDebit)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-[#77756F]">جمع کل بستانکار</dt>
            <dd className="mt-1 whitespace-nowrap text-sm font-bold text-[#252522]">{formatToman(data.totalCredit)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
