"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, inputClass, PrimaryButton } from "@/app/dashboard/ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { AccountRow, Runner } from "./accounting-manager";
import { cardClass } from "@/app/dashboard/page-chrome";

interface ExpenseRow {
  id: string;
  expenseDate: string;
  accountCode: string;
  accountName: string;
  paymentAccountCode: string;
  paymentAccountName: string;
  amount: number;
  vendor: string | null;
  memo: string;
  createdByName: string | null;
}

/**
 * Categorised operating expenses, recorded as paid — the expense account
 * chosen (rent, utilities, marketing, …) is the category, so no separate
 * taxonomy exists. Posts immediately (Debit expense account / Credit
 * payment account), same as an order or purchase would, rather than going
 * through the manual-journal draft/review/post workflow — this is a
 * routine, already-categorised entry, not a freeform one.
 */
export function ExpenseSection({
  accounts,
  busy,
  run,
  refreshKey,
}: {
  accounts: AccountRow[];
  busy: boolean;
  run: Runner;
  refreshKey: number;
}) {
  const expenseAccounts = accounts.filter((a) => a.type === "expense");
  const paymentAccounts = accounts.filter((a) => a.type === "asset");

  const money = useMoney();
  const [accountId, setAccountId] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState("");
  const [vendor, setVendor] = useState("");
  const [memo, setMemo] = useState("");
  const [expenses, setExpenses] = useState<ExpenseRow[] | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    setLoadError("");
    api<{ expenses: ExpenseRow[] }>("/api/ledger/expenses").then(({ ok, data }) => {
      if (ok) setExpenses(data.expenses);
      // An endless skeleton reads as "still loading"; name the failure.
      else {
        setExpenses([]);
        setLoadError("بارگذاری فهرست هزینه‌ها ناموفق بود.");
      }
    });
  }, [refreshKey]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !paymentAccountId || !amount.trim() || !memo.trim()) return;
    let rial: number;
    try {
      rial = money.parse(amount);
    } catch {
      return;
    }
    const ok = await run(() =>
      api("/api/ledger/expenses", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          paymentAccountId,
          amount: rial,
          expenseDate: expenseDate || undefined,
          vendor: vendor.trim() || undefined,
          memo,
        }),
      }),
    );
    if (ok) {
      setAccountId("");
      setPaymentAccountId("");
      setAmount("");
      setExpenseDate("");
      setVendor("");
      setMemo("");
    }
  }

  return (
    <div className="space-y-4">
      <section className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">عملیات هزینه</p>
          <h2 className="mt-1 text-base font-semibold text-foreground">ثبت هزینه</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            هزینه به‌عنوان پرداخت‌شده ثبت می‌شود و بلافاصله در دفاتر موجود منعکس خواهد شد.
          </p>
        </header>

        <form onSubmit={submit} className="grid gap-3 p-4 sm:p-5 md:grid-cols-2 xl:grid-cols-3">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">دسته هزینه</span>
            <SearchableSelect
              value={accountId}
              onChange={setAccountId}
              options={[
                { value: "", label: "انتخاب دسته هزینه" },
                ...expenseAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
              ]}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">پرداخت از</span>
            <SearchableSelect
              value={paymentAccountId}
              onChange={setPaymentAccountId}
              options={[
                { value: "", label: "انتخاب حساب پرداخت" },
                ...paymentAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
              ]}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">مبلغ ({money.unitLabel})</span>
            <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="۰" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">تاریخ هزینه</span>
            <JalaliDatePicker value={expenseDate} onChange={setExpenseDate} placeholder="امروز" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">
              طرف حساب <span className="font-normal text-muted-foreground">(اختیاری)</span>
            </span>
            <input className={inputClass} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="نام طرف حساب" />
          </label>
          <label className="block md:col-span-2 xl:col-span-3">
            <span className="mb-1.5 block text-sm font-medium text-foreground">شرح هزینه</span>
            <input className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="شرح و دلیل ثبت هزینه" required />
          </label>
          <div className="md:col-span-2 xl:col-span-3">
            <div className="max-w-xs">
              <PrimaryButton disabled={busy || !accountId || !paymentAccountId || !amount.trim() || !memo.trim()}>
                ثبت هزینه
              </PrimaryButton>
            </div>
          </div>
        </form>
      </section>

      <section className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق عملیاتی</p>
          <h2 className="mt-1 text-base font-semibold text-foreground">هزینه‌های اخیر</h2>
        </header>
        <div className="p-4 sm:p-5">
          <ErrorBox>{loadError}</ErrorBox>
          {!expenses ? (
            <LoadingSkeleton rows={3} />
          ) : expenses.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              هنوز هزینه‌ای ثبت نشده است.
            </p>
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400">
                      <tr className="border-b border-border">
                        <th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">تاریخ</th>
                        <th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">دسته</th>
                        <th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">شرح</th>
                        <th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">طرف حساب</th>
                        <th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">پرداخت از</th>
                        <th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">مبلغ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expenses.map((e) => (
                        <tr key={e.id} className="border-b border-border last:border-b-0">
                          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                            {toPersianDigits(formatJalali(e.expenseDate))}
                          </td>
                          <td className="px-4 py-3 text-foreground">
                            {e.accountCode} {e.accountName}
                          </td>
                          <td className="px-4 py-3 text-foreground">{e.memo}</td>
                          <td className="px-4 py-3 text-muted-foreground">{e.vendor ?? "—"}</td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {e.paymentAccountCode} {e.paymentAccountName}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 font-semibold text-foreground">
                            {money.format(e.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <p className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-stone-50/60 px-4 py-3 text-sm dark:bg-stone-800/30">
                <span className="text-muted-foreground">جمع هزینه‌های این فهرست</span>
                <span className="font-bold tabular-nums text-foreground">
                  {money.format(expenses.reduce((sum, e) => sum + e.amount, 0))}
                </span>
              </p>
              <div className="space-y-3 lg:hidden">
                {expenses.map((e) => (
                  <article key={e.id} className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold text-foreground">
                          {e.accountCode} {e.accountName}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">{toPersianDigits(formatJalali(e.expenseDate))}</p>
                      </div>
                      <span className="whitespace-nowrap font-bold text-foreground">{money.format(e.amount)}</span>
                    </div>
                    <p className="mt-3 text-sm text-foreground">{e.memo}</p>
                    <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs">
                      <div>
                        <dt className="text-muted-foreground">طرف حساب</dt>
                        <dd className="mt-1 text-sm text-foreground">{e.vendor ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">پرداخت از</dt>
                        <dd className="mt-1 text-sm text-foreground">
                          {e.paymentAccountCode} {e.paymentAccountName}
                        </dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
