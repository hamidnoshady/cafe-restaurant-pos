"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatToman, parseToRial } from "@/lib/money";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, inputClass, PrimaryButton } from "../ui";
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
    <div className="space-y-6">
      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">ثبت هزینه</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          دسته‌بندی هزینه همان حساب هزینه انتخابی است (اجاره، آب و برق، بازاریابی، …). هزینه به‌عنوان پرداخت‌شده ثبت
          می‌شود و بلافاصله در دفاتر منعکس می‌شود.
        </p>
        <form onSubmit={submit} className="grid gap-2 sm:grid-cols-6">
          <select className={`${inputClass} sm:col-span-2`} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">دسته هزینه…</option>
            {expenseAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
          <select className={inputClass} value={paymentAccountId} onChange={(e) => setPaymentAccountId(e.target.value)}>
            <option value="">پرداخت از…</option>
            {paymentAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
          <input
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="مبلغ (تومان)"
          />
          <div className="sm:col-span-1">
            <JalaliDatePicker value={expenseDate} onChange={setExpenseDate} placeholder="تاریخ (امروز)" />
          </div>
          <input className={inputClass} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="طرف حساب (اختیاری)" />
          <input
            className={`${inputClass} sm:col-span-6`}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="شرح هزینه"
            required
          />
          <div className="sm:col-span-6">
            <PrimaryButton disabled={busy || !accountId || !paymentAccountId || !amount.trim() || !memo.trim()}>
              ثبت هزینه
            </PrimaryButton>
          </div>
        </form>
      </section>

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">هزینه‌های اخیر</h2>
        {!expenses ? (
          <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : expenses.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز هزینه‌ای ثبت نشده است.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-start text-muted-foreground">
                  <th className="py-2 pe-3 text-start">تاریخ</th>
                  <th className="py-2 pe-3 text-start">دسته</th>
                  <th className="py-2 pe-3 text-start">شرح</th>
                  <th className="py-2 pe-3 text-start">طرف حساب</th>
                  <th className="py-2 pe-3 text-start">پرداخت از</th>
                  <th className="py-2 text-start">مبلغ</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((e) => (
                  <tr key={e.id} className="border-b border-border">
                    <td className="py-2 pe-3 text-muted-foreground">{toPersianDigits(formatJalali(e.expenseDate))}</td>
                    <td className="py-2 pe-3">
                      {e.accountCode} {e.accountName}
                    </td>
                    <td className="py-2 pe-3">{e.memo}</td>
                    <td className="py-2 pe-3 text-muted-foreground">{e.vendor ?? "—"}</td>
                    <td className="py-2 pe-3 text-muted-foreground">
                      {e.paymentAccountCode} {e.paymentAccountName}
                    </td>
                    <td className="py-2">{formatToman(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
