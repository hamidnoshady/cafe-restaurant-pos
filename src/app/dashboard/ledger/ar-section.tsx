"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, ErrorBox, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import { ArStatementPanel } from "./ar-statement-panel";

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

  useEffect(() => {
    api<{ customers: CustomerBalance[] }>("/api/ledger/ar/customers").then(({ ok, data }) => {
      if (ok) setCustomers(data.customers);
    });
  }, [refreshKey]);

  useEffect(() => {
    if (view !== "aging") return;
    api<AgingReport>("/api/ledger/ar/aging").then(({ ok, data }) => {
      if (ok) setAging(data);
    });
  }, [view, refreshKey]);

  if (!customers) {
    return <section aria-live="polite" className="rounded-2xl border border-stone-200/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-5 text-sm text-muted-foreground">در حال بارگذاری…</section>;
  }

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className="rounded-2xl border border-stone-200/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-amber-700">مطالبات مشتریان</p>
            <h2 className="mt-1">حساب‌های دریافتنی</h2>
            <p className="mt-1 text-sm text-muted-foreground">مانده حساب‌ها و نمای سنی بدهی مشتریان، بر پایه ثبت‌های فعلی.</p>
          </div>
          <div className="grid min-w-full grid-cols-2 gap-2 sm:min-w-0">
            <button type="button" aria-pressed={view === "balances"} onClick={() => setView("balances")} className={`min-h-12 rounded-xl border px-3 text-sm ${view === "balances" ? "border-amber-200 bg-amber-100 font-semibold text-amber-700" : "border-transparent text-muted-foreground hover:border-stone-200/80 hover:bg-stone-50"}`}>مانده حساب‌ها</button>
            <button type="button" aria-pressed={view === "aging"} onClick={() => setView("aging")} className={`min-h-12 rounded-xl border px-3 text-sm ${view === "aging" ? "border-amber-200 bg-amber-100 font-semibold text-amber-700" : "border-transparent text-muted-foreground hover:border-stone-200/80 hover:bg-stone-50"}`}>نمای سنی بدهی‌ها</button>
          </div>
        </div>

        {view === "balances" ? (
          <div className="mt-5">
            {customers.length === 0 ? (
              <p className="rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-8 text-center text-sm text-muted-foreground">هیچ حساب دریافتنی بازی وجود ندارد.</p>
            ) : (
              <>
                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-border"><th className="py-3 pe-3 text-start">مشتری</th><th className="py-3 pe-3 text-start">تلفن</th><th className="py-3 pe-3 text-start">مانده</th><th className="py-3 text-start">اقدام</th></tr></thead>
                    <tbody>
                      {customers.map((c) => (
                        <tr key={c.customerId} className="border-b border-border">
                          <td className="py-3 pe-3"><button type="button" onClick={() => setStatementTarget({ id: c.customerId, name: c.customerName })} className="font-semibold hover:text-amber-700 hover:underline">{c.customerName}</button></td>
                          <td className="py-3 pe-3 text-muted-foreground">{c.customerPhone ? toPersianDigits(c.customerPhone) : "—"}</td>
                          <td className="whitespace-nowrap py-3 pe-3 font-bold">{money.format(c.balance)}</td>
                          <td className="py-3">{c.customerId !== "unknown" ? <button type="button" onClick={() => setReceiveTarget(c)} className="rounded-lg px-3 text-xs font-semibold text-amber-700 hover:bg-amber-100">دریافت وجه</button> : null}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-3 lg:hidden">
                  {customers.map((c) => (
                    <article key={c.customerId} className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0"><button type="button" onClick={() => setStatementTarget({ id: c.customerId, name: c.customerName })} className="truncate text-right font-bold hover:text-amber-700">{c.customerName}</button><p className="mt-1 text-xs text-muted-foreground">{c.customerPhone ? toPersianDigits(c.customerPhone) : "شماره‌ای ثبت نشده"}</p></div>
                        <span className="whitespace-nowrap font-bold">{money.format(c.balance)}</span>
                      </div>
                      {c.customerId !== "unknown" ? <button type="button" onClick={() => setReceiveTarget(c)} className="mt-3 rounded-lg bg-amber-100 px-4 text-sm font-semibold text-amber-700">دریافت وجه</button> : null}
                    </article>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="mt-5">
            {!aging ? (
              <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
            ) : aging.rows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-8 text-center text-sm text-muted-foreground">هیچ حساب دریافتنی بازی وجود ندارد.</p>
            ) : (
              <>
                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-border"><th className="py-3 pe-3 text-start">مشتری</th>{AGING_COLUMNS.map((col) => <th key={col.key} className="py-3 pe-3 text-start">{col.label}</th>)}</tr></thead>
                    <tbody>{aging.rows.map((r) => <tr key={r.customerId} className="border-b border-border"><td className="py-3 pe-3 font-medium">{r.customerName}</td>{AGING_COLUMNS.map((col) => <td key={col.key} className={`whitespace-nowrap py-3 pe-3 ${col.key === "total" ? "font-bold" : ""}`}>{r[col.key] ? money.format(r[col.key]) : "—"}</td>)}</tr>)}</tbody>
                    <tfoot><tr className="border-t-2 border-input font-bold"><td className="py-3 pe-3">جمع کل</td>{AGING_COLUMNS.map((col) => <td key={col.key} className="whitespace-nowrap py-3 pe-3">{money.format(aging.totals[col.key])}</td>)}</tr></tfoot>
                  </table>
                </div>
                <div className="space-y-3 lg:hidden">
                  {aging.rows.map((r) => (
                    <article key={r.customerId} className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
                      <div className="flex justify-between gap-3"><h3>{r.customerName}</h3><span className="whitespace-nowrap font-bold">{money.format(r.total)}</span></div>
                      <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-stone-100 pt-3 text-sm">
                        {AGING_COLUMNS.filter((col) => col.key !== "total").map((col) => <div key={col.key}><dt className="text-xs text-muted-foreground">{col.label}</dt><dd className="mt-1 font-semibold">{r[col.key] ? money.format(r[col.key]) : "—"}</dd></div>)}
                      </dl>
                    </article>
                  ))}
                  <dl className="rounded-xl border border-stone-200/80 bg-stone-50 p-4"><dt className="text-sm text-muted-foreground">جمع کل حساب‌های دریافتنی</dt><dd className="mt-1 text-lg font-bold">{money.format(aging.totals.total)}</dd></dl>
                </div>
              </>
            )}
          </div>
        )}
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
        className="w-full max-w-md rounded-2xl bg-card p-4 shadow-lg sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 border-b border-border pb-4">
          <p className="text-xs font-semibold text-amber-700">ثبت دریافت</p>
          <h3 id="receive-payment-heading" className="mt-1 text-lg font-bold">دریافت وجه از {customer.customerName}</h3>
        </header>
        <ErrorBox>{localError}</ErrorBox>
        <div className="space-y-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted-foreground">مبلغ ({money.unitLabel})</span>
            <input className={inputClass} dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted-foreground">روش دریافت</span>
            <SearchableSelect
              value={method}
              onChange={(value) => setMethod(value as "cash" | "bank")}
              options={[
                { value: "cash", label: "نقدی" },
                { value: "bank", label: "بانکی" },
              ]}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted-foreground">شرح (اختیاری)</span>
            <input className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} />
          </label>
        </div>
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
