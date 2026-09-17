"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber } from "@/lib/digits";
import { api, ErrorBox, SecondaryButton } from "@/app/dashboard/ui";
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
  entryCount: number;
  lineCount: number;
  unbalancedEntryCount: number;
  invalidEntryCount: number;
  balanceDifference: number;
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
  const [loading, setLoading] = useState(true);
  // Fetch failures and network exceptions must both leave the loading state.
  // AbortController also prevents a slower, older refresh from overwriting a
  // newer response when the workspace refreshes several sections together.
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const result = await api<TrialBalanceData>("/api/ledger/trial-balance", { signal });
      if (signal.aborted) return;
      if (result.ok) setData(result.data);
      else setError("بارگذاری تراز آزمایشی ناموفق بود. دوباره تلاش کنید.");
    } catch {
      if (!signal.aborted) setError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey, retryKey]);

  if (!data) {
    return (
      <>
        <ErrorBox>{error}</ErrorBox>
        {error ? (
          <div className="mt-3 flex justify-center">
            <SecondaryButton onClick={() => setRetryKey((key) => key + 1)}>
              تلاش دوباره
            </SecondaryButton>
          </div>
        ) : (
          <SectionCardSkeleton rows={4} label="در حال بارگذاری تراز آزمایشی" />
        )}
      </>
    );
  }

  // Keep the API response as the financial source of truth. This UI only
  // removes entirely empty accounts from display, exactly as before.
  const rows = data.accounts.filter(
    (a) => Number(a.debit) !== 0 || Number(a.credit) !== 0,
  );
  const hasEntries = data.entryCount > 0;
  const statusTone = !hasEntries
    ? "neutral"
    : data.balanced
      ? "positive"
      : "danger";
  const statusText = !hasEntries
    ? "بدون سند"
    : data.balanced
      ? "متوازن"
      : "نامتوازن";
  const problemParts: string[] = [];
  if (data.unbalancedEntryCount > 0) {
    problemParts.push(
      `${formatPersianNumber(data.unbalancedEntryCount)} سند نامتوازن`,
    );
  }
  if (data.invalidEntryCount > 0) {
    problemParts.push(
      `${formatPersianNumber(data.invalidEntryCount)} سند ناقص`,
    );
  }
  const statusDescription = !hasEntries
    ? `${formatPersianNumber(data.entryCount)} سند و ${formatPersianNumber(data.lineCount)} ردیف ثبت شده است؛ صفر بودن دو طرف دفتر خالی توازن محسوب نمی‌شود.`
    : data.balanced
      ? `${formatPersianNumber(data.entryCount)} سند و ${formatPersianNumber(data.lineCount)} ردیف ثبت‌شده؛ کنترل توازن در سطح سند انجام شد.`
      : `${formatPersianNumber(data.entryCount)} سند و ${formatPersianNumber(data.lineCount)} ردیف ثبت‌شده؛ ${problemParts.join("، ") || "نیازمند بازبینی"}؛ اختلاف کل: ${money.format(Math.abs(data.balanceDifference))}`;
  const emptyRowsMessage = hasEntries
    ? "برای اسناد موجود ردیف حسابداری قابل نمایش وجود ندارد؛ این وضعیت نیازمند بازبینی است."
    : "هنوز سندی ثبت نشده است.";

  return (
    <section
      aria-labelledby="trial-balance-heading"
      aria-busy={loading}
      className={cardClass}
    >
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
            گزارش مالی
          </p>
          <h2
            id="trial-balance-heading"
            className="mt-1 text-base font-semibold text-foreground"
          >
            تراز آزمایشی
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {statusDescription}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold ${
              statusTone === "positive"
                ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200"
                : statusTone === "danger"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
            {statusText}
          </span>
          <SecondaryButton
            onClick={() => setRetryKey((key) => key + 1)}
            disabled={loading}
            className="min-h-8 px-2.5 text-xs"
          >
            <RefreshCwIcon aria-hidden="true" className={`me-1.5 size-3.5 ${loading ? "animate-spin" : ""}`} />
            بروزرسانی
          </SecondaryButton>
        </div>
      </header>

      <div className="p-4 sm:p-5">
        <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">فهرست حساب‌ها و ماندهٔ بدهکار و بستانکار</caption>
              <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400">
                <tr className="border-b border-border">
                  <th
                    scope="col"
                    className="px-4 py-3.5 text-start text-xs font-medium sm:text-sm"
                  >
                    کد
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3.5 text-start text-xs font-medium sm:text-sm"
                  >
                    حساب
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3.5 text-start text-xs font-medium sm:text-sm"
                  >
                    نوع
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3.5 text-start text-xs font-medium sm:text-sm"
                  >
                    بدهکار
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3.5 text-start text-xs font-medium sm:text-sm"
                  >
                    بستانکار
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr
                    key={a.id}
                    className="border-b border-border last:border-b-0"
                  >
                    <td className="whitespace-nowrap px-4 py-3.5 font-medium text-muted-foreground">
                      {a.code}
                    </td>
                    <td className="px-4 py-3.5 font-medium text-foreground">
                      {a.name}
                      {a.isActive === false ? (
                        <span className="ms-2 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                          غیرفعال
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3.5 text-muted-foreground">
                      {TYPE_LABELS[a.type]}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5 text-end font-semibold text-foreground">
                      {money.format(Number(a.debit))}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5 text-end font-semibold text-foreground">
                      {money.format(Number(a.credit))}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-10 text-center text-sm text-muted-foreground"
                    >
                      {emptyRowsMessage}
                    </td>
                  </tr>
                ) : null}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-stone-50/60 text-foreground dark:bg-stone-800/30">
                  <th
                    scope="row"
                    className="px-4 py-3.5 text-start font-semibold"
                    colSpan={3}
                  >
                    جمع کل
                  </th>
                  <td className="whitespace-nowrap px-4 py-3.5 text-end font-bold">
                    {money.format(data.totalDebit)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3.5 text-end font-bold">
                    {money.format(data.totalCredit)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div className="space-y-3 lg:hidden">
          {rows.map((a) => (
            <article
              key={a.id}
              className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">
                    {a.code}
                  </p>
                  <h3 className="mt-1 break-words text-sm font-semibold text-foreground">
                    {a.name}
                  </h3>
                  {a.isActive === false ? (
                    <p className="mt-1 text-xs font-semibold text-muted-foreground">
                      غیرفعال
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                  {TYPE_LABELS[a.type]}
                </span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-3">
                <div className="rounded-lg bg-stone-50 px-3 py-2.5 dark:bg-stone-800/40">
                  <dt className="text-xs text-muted-foreground">بدهکار</dt>
                  <dd className="mt-1 whitespace-nowrap text-end text-sm font-semibold text-foreground">
                    {money.format(Number(a.debit))}
                  </dd>
                </div>
                <div className="rounded-lg bg-stone-50 px-3 py-2.5 dark:bg-stone-800/40">
                  <dt className="text-xs text-muted-foreground">بستانکار</dt>
                  <dd className="mt-1 whitespace-nowrap text-end text-sm font-semibold text-foreground">
                    {money.format(Number(a.credit))}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              {emptyRowsMessage}
            </p>
          ) : null}
          <dl className="grid grid-cols-2 gap-3 rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                جمع کل بدهکار
              </dt>
              <dd className="mt-1 whitespace-nowrap text-end text-sm font-bold text-foreground">
                {money.format(data.totalDebit)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                جمع کل بستانکار
              </dt>
              <dd className="mt-1 whitespace-nowrap text-end text-sm font-bold text-foreground">
                {money.format(data.totalCredit)}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
