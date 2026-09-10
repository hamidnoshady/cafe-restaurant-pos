"use client";

import { LoadingSkeleton, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useState } from "react";
import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import { ArStatementPanel } from "./ar-statement-panel";
import { useOverlayEscape } from "./use-overlay-escape";
import { accountingCustomersHref } from "./ledger-routes";
import { cardClass, overlayPanelClass } from "../page-chrome";

interface CustomerBalance {
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  balance: number;
}

interface AgingRow {
  customerId: string;
  customerName: string;
  current: number;
  d31_60: number;
  d61_90: number;
  over90: number;
  total: number;
}

interface AgingReport {
  asOfDate: string;
  rows: AgingRow[];
  totals: Omit<AgingRow, "customerId" | "customerName">;
}

const AGING_COLUMNS: { key: keyof Omit<AgingRow, "customerId" | "customerName">; label: string }[] = [
  { key: "current", label: "جاری (۰-۳۰ روز)" },
  { key: "d31_60", label: "۳۱-۶۰ روز" },
  { key: "d61_90", label: "۶۱-۹۰ روز" },
  { key: "over90", label: "بیش از ۹۰ روز" },
  { key: "total", label: "جمع" },
];

export function ArSection({ busy, run }: { busy: boolean; run: (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean> }) {
  const money = useMoney();
  const [customers, setCustomers] = useState<CustomerBalance[] | null>(null);
  const [view, setView] = useState<"balances" | "aging">("balances");
  const [aging, setAging] = useState<AgingReport | null>(null);
  const [statementTarget, setStatementTarget] = useState<{ id: string; name: string } | null>(null);
  const [receiveTarget, setReceiveTarget] = useState<CustomerBalance | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");
  /*
   * «تا تاریخ» — the aging report's as-of date.
   *
   * `GET /api/ledger/ar/aging?asOfDate=` has always accepted one and the report
   * has always answered with the date it used, but the screen neither sent nor
   * showed it: the buckets were silently "as of today" and there was no way to
   * ask what the ageing looked like at a period end.
   */
  const [asOfDate, setAsOfDate] = useState("");

  useEffect(() => {
    api<{ customers: CustomerBalance[] }>("/api/ledger/ar/customers").then(({ ok, data }) => {
      if (ok) setCustomers(data.customers);
      // Not `null` for ever: an unending skeleton claims the request is still
      // running. An empty list plus the reason is the honest answer.
      else {
        setCustomers([]);
        setError("بارگذاری مانده‌های دریافتنی ناموفق بود.");
      }
    });
  }, [refreshKey]);

  useEffect(() => {
    if (view !== "aging") return;
    setAging(null);
    api<AgingReport>(`/api/ledger/ar/aging${asOfDate ? `?asOfDate=${asOfDate}` : ""}`).then(({ ok, data }) => {
      if (ok) setAging(data);
      else {
        setAging({ asOfDate: "", rows: [], totals: { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 } });
        setError("بارگذاری نمای سنی بدهی‌ها ناموفق بود.");
      }
    });
  }, [view, asOfDate, refreshKey]);

  if (!customers) {
    return <SectionCardSkeleton rows={4} />;
  }

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مطالبات مشتریان</p>
            <h2 className="mt-1 text-base font-semibold text-foreground">حساب‌های دریافتنی</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              مانده حساب‌ها و نمای سنی بدهی مشتریان، بر پایه ثبت‌های فعلی.
            </p>
          </div>
          <div className="flex min-w-full flex-col items-stretch gap-2 sm:min-w-0 sm:items-end">
            <Link
              href={accountingCustomersHref()}
              className="inline-flex min-h-10 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-primary transition-colors hover:bg-stone-50 dark:hover:bg-stone-800/40"
            >
              مشتریان در حسابداری
            </Link>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" aria-pressed={view === "balances"} onClick={() => setView("balances")} className={`min-h-12 rounded-xl border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40 ${view === "balances" ? "border-amber-200 bg-amber-100 font-semibold text-amber-950 shadow-[0_1px_2px_rgb(120_53_15/0.08)] dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200" : "border-transparent text-muted-foreground hover:border-border hover:bg-stone-50 hover:text-foreground dark:hover:bg-stone-800/40"}`}>مانده حساب‌ها</button>
              <button type="button" aria-pressed={view === "aging"} onClick={() => setView("aging")} className={`min-h-12 rounded-xl border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40 ${view === "aging" ? "border-amber-200 bg-amber-100 font-semibold text-amber-950 shadow-[0_1px_2px_rgb(120_53_15/0.08)] dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200" : "border-transparent text-muted-foreground hover:border-border hover:bg-stone-50 hover:text-foreground dark:hover:bg-stone-800/40"}`}>نمای سنی بدهی‌ها</button>
            </div>
          </div>
        </div>

        <div className="p-4 sm:p-5">
        {view === "balances" ? (
          <div>
            {customers.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">هیچ حساب دریافتنی بازی وجود ندارد.</p>
            ) : (
              <>
                <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400"><tr className="border-b border-border"><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">مشتری</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">تلفن</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">مانده</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">اقدام</th></tr></thead>
                      <tbody>
                        {customers.map((c) => (
                          <tr key={c.customerId} className="border-b border-border last:border-b-0">
                            <td className="px-4 py-3"><button type="button" onClick={() => setStatementTarget({ id: c.customerId, name: c.customerName })} className="font-semibold text-foreground hover:text-amber-700 hover:underline dark:hover:text-amber-300">{c.customerName}</button></td>
                            <td className="px-4 py-3 text-muted-foreground">{c.customerPhone ? toPersianDigits(c.customerPhone) : "—"}</td>
                            <td className="whitespace-nowrap px-4 py-3 font-bold text-foreground">{money.format(c.balance)}</td>
                            <td className="px-4 py-3">{c.customerId !== "unknown" ? <button type="button" onClick={() => setReceiveTarget(c)} className="rounded-lg px-3 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20">دریافت وجه</button> : null}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="space-y-3 lg:hidden">
                  {customers.map((c) => (
                    <article key={c.customerId} className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0"><button type="button" onClick={() => setStatementTarget({ id: c.customerId, name: c.customerName })} className="truncate text-right font-bold text-foreground hover:text-amber-700 dark:hover:text-amber-300">{c.customerName}</button><p className="mt-1 text-xs text-muted-foreground">{c.customerPhone ? toPersianDigits(c.customerPhone) : "شماره‌ای ثبت نشده"}</p></div>
                        <span className="whitespace-nowrap font-bold text-foreground">{money.format(c.balance)}</span>
                      </div>
                      {c.customerId !== "unknown" ? <button type="button" onClick={() => setReceiveTarget(c)} className="mt-3 rounded-lg bg-amber-100 px-4 text-sm font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200">دریافت وجه</button> : null}
                    </article>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div>
            <div className="mb-4 grid gap-3 rounded-xl border border-border/80 bg-stone-50/60 p-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-end dark:bg-stone-800/30">
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted-foreground">نمای سنی تا تاریخ</span>
                <JalaliDatePicker value={asOfDate} onChange={setAsOfDate} placeholder="امروز" />
              </label>
              {aging?.asOfDate ? (
                <p className="text-xs leading-6 text-muted-foreground">
                  محاسبه‌شده تا {toPersianDigits(formatJalali(aging.asOfDate))}
                </p>
              ) : null}
            </div>
            {!aging ? (
              <LoadingSkeleton rows={3} />
            ) : aging.rows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">هیچ حساب دریافتنی بازی وجود ندارد.</p>
            ) : (
              <>
                <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400"><tr className="border-b border-border"><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">مشتری</th>{AGING_COLUMNS.map((col) => <th key={col.key} className="px-4 py-3 text-start text-xs font-medium sm:text-sm">{col.label}</th>)}</tr></thead>
                      <tbody>{aging.rows.map((r) => <tr key={r.customerId} className="border-b border-border last:border-b-0"><td className="px-4 py-3 font-medium text-foreground">{r.customerName}</td>{AGING_COLUMNS.map((col) => <td key={col.key} className={`whitespace-nowrap px-4 py-3 ${col.key === "total" ? "font-bold text-foreground" : "text-foreground"}`}>{r[col.key] ? money.format(r[col.key]) : "—"}</td>)}</tr>)}</tbody>
                      <tfoot><tr className="border-t border-border bg-stone-50/60 font-semibold dark:bg-stone-800/30"><td className="px-4 py-3 text-foreground">جمع کل</td>{AGING_COLUMNS.map((col) => <td key={col.key} className="whitespace-nowrap px-4 py-3 font-bold text-foreground">{money.format(aging.totals[col.key])}</td>)}</tr></tfoot>
                    </table>
                  </div>
                </div>
                <div className="space-y-3 lg:hidden">
                  {aging.rows.map((r) => (
                    <article key={r.customerId} className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                      <div className="flex justify-between gap-3"><h3 className="text-sm font-semibold text-foreground">{r.customerName}</h3><span className="whitespace-nowrap font-bold text-foreground">{money.format(r.total)}</span></div>
                      <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm">
                        {AGING_COLUMNS.filter((col) => col.key !== "total").map((col) => <div key={col.key}><dt className="text-xs text-muted-foreground">{col.label}</dt><dd className="mt-1 font-semibold text-foreground">{r[col.key] ? money.format(r[col.key]) : "—"}</dd></div>)}
                      </dl>
                    </article>
                  ))}
                  <dl className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30"><dt className="text-sm text-muted-foreground">جمع کل حساب‌های دریافتنی</dt><dd className="mt-1 text-lg font-bold text-foreground">{money.format(aging.totals.total)}</dd></dl>
                </div>
              </>
            )}
          </div>
        )}
        </div>
      </div>

      {statementTarget ? <ArStatementPanel customerId={statementTarget.id} customerName={statementTarget.name} onClose={() => setStatementTarget(null)} /> : null}

      {receiveTarget ? (
        <ReceivePaymentDialog
          customer={receiveTarget}
          busy={busy}
          onClose={() => setReceiveTarget(null)}
          onSubmit={async (body) => {
            setError("");
            const ok = await run(() => api("/api/ledger/ar/receipts", { method: "POST", body: JSON.stringify(body) }));
            if (ok) {
              setReceiveTarget(null);
              setRefreshKey((k) => k + 1);
            }
            return ok;
          }}
        />
      ) : null}
    </section>
  );
}

function ReceivePaymentDialog({
  customer,
  busy,
  onClose,
  onSubmit,
}: {
  customer: CustomerBalance;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { customerId: string; amount: number; method: "cash" | "bank"; memo?: string }) => Promise<boolean>;
}) {
  const money = useMoney();
  const [amount, setAmount] = useState(String(money.toInput(Math.max(customer.balance, 0)) || ""));
  const [method, setMethod] = useState<"cash" | "bank">("cash");
  const [memo, setMemo] = useState("");
  const [localError, setLocalError] = useState("");
  useOverlayEscape(onClose);

  async function submit() {
    let rial: number;
    try {
      rial = money.parse(amount);
    } catch {
      setLocalError(errorMessage("invalid_amount"));
      return;
    }
    if (rial <= 0) {
      setLocalError(errorMessage("invalid_amount"));
      return;
    }
    setLocalError("");
    await onSubmit({ customerId: customer.customerId, amount: rial, method, memo: memo.trim() || undefined });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="receive-payment-heading"
        className={`${overlayPanelClass} w-full max-w-md p-4 sm:p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 border-b border-border pb-4">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ثبت دریافت</p>
          <h3 id="receive-payment-heading" className="mt-1 text-lg font-bold">دریافت وجه از {customer.customerName}</h3>
        </header>
        <ErrorBox>{localError}</ErrorBox>
        <Field label={`مبلغ (${money.unitLabel})`}>
          <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="روش دریافت">
          <SearchableSelect
            value={method}
            onChange={(value) => setMethod(value as "cash" | "bank")}
            options={[
              { value: "cash", label: "نقدی" },
              { value: "bank", label: "بانکی" },
            ]}
          />
        </Field>
        <Field label="شرح (اختیاری)">
          <input className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </Field>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton onClick={onClose} disabled={busy}>
            انصراف
          </SecondaryButton>
          <PrimaryButton onClick={submit} disabled={busy}>
            ثبت دریافت
          </PrimaryButton>
        </div>
      </section>
    </div>
  );
}
