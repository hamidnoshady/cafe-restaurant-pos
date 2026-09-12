"use client";

import { LoadingSkeleton, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { ApStatementPanel } from "./ap-statement-panel";
import { useOverlayEscape } from "./use-overlay-escape";
import { cardClass, overlayPanelClass } from "@/app/dashboard/page-chrome";

interface SupplierBalance {
  supplierId: string;
  supplierName: string;
  supplierPhone: string | null;
  balance: number;
}

interface AgingRow {
  supplierId: string;
  supplierName: string;
  current: number;
  d31_60: number;
  d61_90: number;
  over90: number;
  total: number;
}

interface AgingReport {
  asOfDate: string;
  rows: AgingRow[];
  totals: Omit<AgingRow, "supplierId" | "supplierName">;
}

const AGING_COLUMNS: { key: keyof Omit<AgingRow, "supplierId" | "supplierName">; label: string }[] = [
  { key: "current", label: "جاری (۰-۳۰ روز)" },
  { key: "d31_60", label: "۳۱-۶۰ روز" },
  { key: "d61_90", label: "۶۱-۹۰ روز" },
  { key: "over90", label: "بیش از ۹۰ روز" },
  { key: "total", label: "جمع" },
];

export function ApSection({ busy, run }: { busy: boolean; run: (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean> }) {
  const money = useMoney();
  const [suppliers, setSuppliers] = useState<SupplierBalance[] | null>(null);
  const [view, setView] = useState<"balances" | "aging">("balances");
  const [aging, setAging] = useState<AgingReport | null>(null);
  const [statementTarget, setStatementTarget] = useState<{ id: string; name: string } | null>(null);
  const [payTarget, setPayTarget] = useState<SupplierBalance | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");
  /*
   * «تا تاریخ» — the aging report's as-of date.
   *
   * `GET /api/ledger/ap/aging?asOfDate=` has always accepted one and the report
   * has always answered with the date it used, but the screen neither sent nor
   * showed it: the buckets were silently "as of today" and there was no way to
   * ask what the ageing looked like at a period end.
   */
  const [asOfDate, setAsOfDate] = useState("");

  useEffect(() => {
    api<{ suppliers: SupplierBalance[] }>("/api/ledger/ap/suppliers").then(({ ok, data }) => {
      if (ok) setSuppliers(data.suppliers);
      // Same reasoning as A/R: a permanent skeleton reads as "still loading".
      else {
        setSuppliers([]);
        setError("بارگذاری مانده‌های پرداختنی ناموفق بود.");
      }
    });
  }, [refreshKey]);

  useEffect(() => {
    if (view !== "aging") return;
    setAging(null);
    api<AgingReport>(`/api/ledger/ap/aging${asOfDate ? `?asOfDate=${asOfDate}` : ""}`).then(({ ok, data }) => {
      if (ok) setAging(data);
      else {
        setAging({ asOfDate: "", rows: [], totals: { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 } });
        setError("بارگذاری نمای سنی بدهی‌ها ناموفق بود.");
      }
    });
  }, [view, asOfDate, refreshKey]);

  if (!suppliers) {
    return <SectionCardSkeleton rows={4} />;
  }

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">تعهدات تأمین‌کنندگان</p>
            <h2 className="mt-1 text-base font-semibold text-foreground">حساب‌های پرداختنی</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              مانده حساب‌ها و نمای سنی بدهی تأمین‌کنندگان، بر پایه ثبت‌های فعلی.
            </p>
          </div>
          <div className="grid min-w-full grid-cols-2 gap-2 sm:min-w-0">
              <button type="button" aria-pressed={view === "balances"} onClick={() => setView("balances")} className={`min-h-12 rounded-xl border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40 ${view === "balances" ? "border-amber-200 bg-amber-100 font-semibold text-amber-950 shadow-[0_1px_2px_rgb(120_53_15/0.08)] dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200" : "border-transparent text-muted-foreground hover:border-border hover:bg-stone-50 hover:text-foreground dark:hover:bg-stone-800/40"}`}>مانده حساب‌ها</button>
              <button type="button" aria-pressed={view === "aging"} onClick={() => setView("aging")} className={`min-h-12 rounded-xl border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40 ${view === "aging" ? "border-amber-200 bg-amber-100 font-semibold text-amber-950 shadow-[0_1px_2px_rgb(120_53_15/0.08)] dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200" : "border-transparent text-muted-foreground hover:border-border hover:bg-stone-50 hover:text-foreground dark:hover:bg-stone-800/40"}`}>نمای سنی بدهی‌ها</button>
          </div>
        </div>

        <div className="p-4 sm:p-5">
        {view === "balances" ? (
          <div>
            {suppliers.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">هیچ حساب پرداختنی بازی وجود ندارد.</p>
            ) : (
              <>
                <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400"><tr className="border-b border-border"><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">تأمین‌کننده</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">تلفن</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">مانده</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">اقدام</th></tr></thead>
                      <tbody>
                        {suppliers.map((s) => (
                          <tr key={s.supplierId} className="border-b border-border last:border-b-0">
                            <td className="px-4 py-3"><button type="button" onClick={() => setStatementTarget({ id: s.supplierId, name: s.supplierName })} className="font-semibold text-foreground hover:text-amber-700 hover:underline dark:hover:text-amber-300">{s.supplierName}</button></td>
                            <td className="px-4 py-3 text-muted-foreground">{s.supplierPhone ? toPersianDigits(s.supplierPhone) : "—"}</td>
                            <td className="whitespace-nowrap px-4 py-3 font-bold text-foreground">{money.format(s.balance)}</td>
                            <td className="px-4 py-3">{s.supplierId !== "unknown" ? <button type="button" onClick={() => setPayTarget(s)} className="rounded-lg px-3 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20">پرداخت</button> : null}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="space-y-3 lg:hidden">
                  {suppliers.map((s) => (
                    <article key={s.supplierId} className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0"><button type="button" onClick={() => setStatementTarget({ id: s.supplierId, name: s.supplierName })} className="truncate text-right font-bold text-foreground hover:text-amber-700 dark:hover:text-amber-300">{s.supplierName}</button><p className="mt-1 text-xs text-muted-foreground">{s.supplierPhone ? toPersianDigits(s.supplierPhone) : "شماره‌ای ثبت نشده"}</p></div>
                        <span className="whitespace-nowrap font-bold text-foreground">{money.format(s.balance)}</span>
                      </div>
                      {s.supplierId !== "unknown" ? <button type="button" onClick={() => setPayTarget(s)} className="mt-3 rounded-lg bg-amber-100 px-4 text-sm font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200">ثبت پرداخت</button> : null}
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
              <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">هیچ حساب پرداختنی بازی وجود ندارد.</p>
            ) : (
              <>
                <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400"><tr className="border-b border-border"><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">تأمین‌کننده</th>{AGING_COLUMNS.map((col) => <th key={col.key} className="px-4 py-3 text-start text-xs font-medium sm:text-sm">{col.label}</th>)}</tr></thead>
                      <tbody>{aging.rows.map((r) => <tr key={r.supplierId} className="border-b border-border last:border-b-0"><td className="px-4 py-3 font-medium text-foreground">{r.supplierName}</td>{AGING_COLUMNS.map((col) => <td key={col.key} className={`whitespace-nowrap px-4 py-3 ${col.key === "total" ? "font-bold text-foreground" : "text-foreground"}`}>{r[col.key] ? money.format(r[col.key]) : "—"}</td>)}</tr>)}</tbody>
                      <tfoot><tr className="border-t border-border bg-stone-50/60 font-semibold dark:bg-stone-800/30"><td className="px-4 py-3 text-foreground">جمع کل</td>{AGING_COLUMNS.map((col) => <td key={col.key} className="whitespace-nowrap px-4 py-3 font-bold text-foreground">{money.format(aging.totals[col.key])}</td>)}</tr></tfoot>
                    </table>
                  </div>
                </div>
                <div className="space-y-3 lg:hidden">
                  {aging.rows.map((r) => (
                    <article key={r.supplierId} className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                      <div className="flex justify-between gap-3"><h3 className="text-sm font-semibold text-foreground">{r.supplierName}</h3><span className="whitespace-nowrap font-bold text-foreground">{money.format(r.total)}</span></div>
                      <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm">
                        {AGING_COLUMNS.filter((col) => col.key !== "total").map((col) => <div key={col.key}><dt className="text-xs text-muted-foreground">{col.label}</dt><dd className="mt-1 font-semibold text-foreground">{r[col.key] ? money.format(r[col.key]) : "—"}</dd></div>)}
                      </dl>
                    </article>
                  ))}
                  <dl className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30"><dt className="text-sm text-muted-foreground">جمع کل حساب‌های پرداختنی</dt><dd className="mt-1 text-lg font-bold text-foreground">{money.format(aging.totals.total)}</dd></dl>
                </div>
              </>
            )}
          </div>
        )}
        </div>
      </div>

      {statementTarget ? <ApStatementPanel supplierId={statementTarget.id} supplierName={statementTarget.name} onClose={() => setStatementTarget(null)} /> : null}

      {payTarget ? (
        <PayBillDialog
          supplier={payTarget}
          busy={busy}
          onClose={() => setPayTarget(null)}
          onSubmit={async (body) => {
            setError("");
            const ok = await run(() => api("/api/ledger/ap/payments", { method: "POST", body: JSON.stringify(body) }));
            if (ok) {
              setPayTarget(null);
              setRefreshKey((k) => k + 1);
            }
            return ok;
          }}
        />
      ) : null}
    </section>
  );
}

function PayBillDialog({
  supplier,
  busy,
  onClose,
  onSubmit,
}: {
  supplier: SupplierBalance;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { supplierId: string; amount: number; method: "cash" | "bank"; memo?: string }) => Promise<boolean>;
}) {
  const money = useMoney();
  const [amount, setAmount] = useState(String(money.toInput(Math.max(supplier.balance, 0)) || ""));
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
    await onSubmit({ supplierId: supplier.supplierId, amount: rial, method, memo: memo.trim() || undefined });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="pay-bill-heading"
        className={`${overlayPanelClass} w-full max-w-md p-4 sm:p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 border-b border-border pb-4">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ثبت پرداخت</p>
          <h3 id="pay-bill-heading" className="mt-1 text-lg font-bold">پرداخت به {supplier.supplierName}</h3>
        </header>
        <ErrorBox>{localError}</ErrorBox>
        <Field label={`مبلغ (${money.unitLabel})`}>
          <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="روش پرداخت">
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
            ثبت پرداخت
          </PrimaryButton>
        </div>
      </section>
    </div>
  );
}
