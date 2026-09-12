"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox } from "@/app/dashboard/ui";
import { cardClass } from "@/app/dashboard/page-chrome";

interface TrialBalanceRow {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  /** False for an archived account. It still reports the postings it received. */
  isActive?: boolean;
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
  // A failed fetch used to leave the skeleton on screen for ever, which reads
  // as "still loading" rather than "this did not load".
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    api<TrialBalanceData>("/api/ledger/trial-balance").then(({ ok, data }) => {
      if (ok) setData(data);
      else setError("بارگذاری تراز آزمایشی ناموفق بود. صفحه را دوباره باز کنید.");
    });
  }, [refreshKey]);

  if (!data) {
    return (
      <>
        <ErrorBox>{error}</ErrorBox>
        {error ? null : <SectionCardSkeleton rows={4} label="در حال بارگذاری تراز آزمایشی" />}
      </>
    );
  }

  // Keep the API response as the financial source of truth. This UI only
  // removes entirely empty accounts from display, exactly as before.
  const rows = data.accounts.filter((a) => Number(a.debit) !== 0 || Number(a.credit) !== 0);

  return (
    <section aria-labelledby="trial-balance-heading" className={cardClass}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">گزارش مالی</p>
          <h2 id="trial-balance-heading" className="mt-1 text-base font-semibold text-foreground">
            تراز آزمایشی
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">مانده حساب‌ها بر پایه اسناد ثبت‌شده</p>
        </div>
        <span
          className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-semibold ${
            data.balanced
              ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200"
              : "bg-destructive/10 text-destructive"
          }`}
        >
          <span aria-hidden="true" className={`size-1.5 rounded-full bg-current`} />
          {data.balanced ? "متوازن" : "نامتوازن"}
        </span>
      </header>

      <div className="p-4 sm:p-5">
        <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400">
                <tr className="border-b border-border">
                  <th scope="col" className="px-4 py-3.5 text-start text-xs font-medium sm:text-sm">
                    کد
                  </th>
                  <th scope="col" className="px-4 py-3.5 text-start text-xs font-medium sm:text-sm">
                    حساب
                  </th>
                  <th scope="col" className="px-4 py-3.5 text-start text-xs font-medium sm:text-sm">
                    نوع
                  </th>
                  <th scope="col" className="px-4 py-3.5 text-start text-xs font-medium sm:text-sm">
                    بدهکار
                  </th>
                  <th scope="col" className="px-4 py-3.5 text-start text-xs font-medium sm:text-sm">
                    بستانکار
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="border-b border-border last:border-b-0">
                    <td className="whitespace-nowrap px-4 py-3.5 font-medium text-muted-foreground">{a.code}</td>
                    <td className="px-4 py-3.5 font-medium text-foreground">
                      {a.name}
                      {a.isActive === false ? (
                        <span className="ms-2 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                          غیرفعال
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3.5 text-muted-foreground">{TYPE_LABELS[a.type]}</td>
                    <td className="whitespace-nowrap px-4 py-3.5 font-semibold text-foreground">
                      {money.format(Number(a.debit))}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5 font-semibold text-foreground">
                      {money.format(Number(a.credit))}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">
                      هنوز سندی ثبت نشده است.
                    </td>
                  </tr>
                ) : null}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-stone-50/60 text-foreground dark:bg-stone-800/30">
                  <th scope="row" className="px-4 py-3.5 text-start font-semibold" colSpan={3}>
                    جمع کل
                  </th>
                  <td className="whitespace-nowrap px-4 py-3.5 font-bold">{money.format(data.totalDebit)}</td>
                  <td className="whitespace-nowrap px-4 py-3.5 font-bold">{money.format(data.totalCredit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div className="space-y-3 lg:hidden">
          {rows.map((a) => (
            <article key={a.id} className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">{a.code}</p>
                  <h3 className="mt-1 truncate text-sm font-semibold text-foreground">{a.name}</h3>
                  {a.isActive === false ? (
                    <p className="mt-1 text-xs font-semibold text-muted-foreground">غیرفعال</p>
                  ) : null}
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                  {TYPE_LABELS[a.type]}
                </span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-3">
                <div className="rounded-lg bg-stone-50 px-3 py-2.5 dark:bg-stone-800/40">
                  <dt className="text-xs text-muted-foreground">بدهکار</dt>
                  <dd className="mt-1 whitespace-nowrap text-sm font-semibold text-foreground">
                    {money.format(Number(a.debit))}
                  </dd>
                </div>
                <div className="rounded-lg bg-stone-50 px-3 py-2.5 dark:bg-stone-800/40">
                  <dt className="text-xs text-muted-foreground">بستانکار</dt>
                  <dd className="mt-1 whitespace-nowrap text-sm font-semibold text-foreground">
                    {money.format(Number(a.credit))}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              هنوز سندی ثبت نشده است.
            </p>
          ) : null}
          <dl className="grid grid-cols-2 gap-3 rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">جمع کل بدهکار</dt>
              <dd className="mt-1 whitespace-nowrap text-sm font-bold text-foreground">
                {money.format(data.totalDebit)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">جمع کل بستانکار</dt>
              <dd className="mt-1 whitespace-nowrap text-sm font-bold text-foreground">
                {money.format(data.totalCredit)}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
