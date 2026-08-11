"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatToman, parseToRial } from "@/lib/money";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, inputClass, PrimaryButton } from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { AccountRow, Runner } from "./ledger-manager";

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

  const [accountId, setAccountId] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState("");
  const [vendor, setVendor] = useState("");
  const [memo, setMemo] = useState("");
  const [expenses, setExpenses] = useState<ExpenseRow[] | null>(null);

  useEffect(() => {
    api<{ expenses: ExpenseRow[] }>("/api/ledger/expenses").then(({ ok, data }) => {
      if (ok) setExpenses(data.expenses);
    });
  }, [refreshKey]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !paymentAccountId || !amount.trim() || !memo.trim()) return;
    let rial: number;
    try {
      rial = parseToRial(amount, "toman");
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
      <section className="rounded-2xl bg-card p-4 shadow-sm sm:p-5">
        <p className="text-xs font-semibold text-[#9B6700]">عملیات هزینه</p>
        <h2 className="mt-1">ثبت هزینه</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          هزینه به‌عنوان پرداخت‌شده ثبت می‌شود و بلافاصله در دفاتر موجود منعکس خواهد شد.
        </p>

        <form onSubmit={submit} className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">دسته هزینه</span>
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
            <span className="mb-1.5 block text-sm font-medium">پرداخت از</span>
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
            <span className="mb-1.5 block text-sm font-medium">مبلغ (تومان)</span>
            <input className={inputClass} dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="۰" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">تاریخ هزینه</span>
            <JalaliDatePicker value={expenseDate} onChange={setExpenseDate} placeholder="امروز" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">طرف حساب <span className="font-normal text-muted-foreground">(اختیاری)</span></span>
            <input className={inputClass} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="نام طرف حساب" />
          </label>
          <label className="block md:col-span-2 xl:col-span-3">
            <span className="mb-1.5 block text-sm font-medium">شرح هزینه</span>
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

      <section className="rounded-2xl bg-card p-4 shadow-sm sm:p-5">
        <div className="mb-4">
          <p className="text-xs font-semibold text-[#9B6700]">سوابق عملیاتی</p>
          <h2 className="mt-1">هزینه‌های اخیر</h2>
        </div>
        {!expenses ? (
          <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : expenses.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[#DEDAD2] bg-[#FCFBF8] px-4 py-8 text-center text-sm text-muted-foreground">
            هنوز هزینه‌ای ثبت نشده است.
          </p>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-start">
                    <th className="py-3 pe-3 text-start">تاریخ</th>
                    <th className="py-3 pe-3 text-start">دسته</th>
                    <th className="py-3 pe-3 text-start">شرح</th>
                    <th className="py-3 pe-3 text-start">طرف حساب</th>
                    <th className="py-3 pe-3 text-start">پرداخت از</th>
                    <th className="py-3 text-start">مبلغ</th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.map((e) => (
                    <tr key={e.id} className="border-b border-border">
                      <td className="whitespace-nowrap py-3 pe-3 text-muted-foreground">{toPersianDigits(formatJalali(e.expenseDate))}</td>
                      <td className="py-3 pe-3">{e.accountCode} {e.accountName}</td>
                      <td className="py-3 pe-3">{e.memo}</td>
                      <td className="py-3 pe-3 text-muted-foreground">{e.vendor ?? "—"}</td>
                      <td className="py-3 pe-3 text-muted-foreground">{e.paymentAccountCode} {e.paymentAccountName}</td>
                      <td className="whitespace-nowrap py-3 font-semibold">{formatToman(e.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-3 lg:hidden">
              {expenses.map((e) => (
                <article key={e.id} className="rounded-xl border border-[#EEECE7] bg-[#FCFBF8] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate">{e.accountCode} {e.accountName}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">{toPersianDigits(formatJalali(e.expenseDate))}</p>
                    </div>
                    <span className="whitespace-nowrap font-bold">{formatToman(e.amount)}</span>
                  </div>
                  <p className="mt-3 text-sm">{e.memo}</p>
                  <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-[#F0EEE9] pt-3 text-xs">
                    <div><dt className="text-muted-foreground">طرف حساب</dt><dd className="mt-1 text-sm">{e.vendor ?? "—"}</dd></div>
                    <div><dt className="text-muted-foreground">پرداخت از</dt><dd className="mt-1 text-sm">{e.paymentAccountCode} {e.paymentAccountName}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
