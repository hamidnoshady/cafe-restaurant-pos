"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, ErrorBox, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import { ApStatementPanel } from "./ap-statement-panel";

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

  useEffect(() => {
    api<{ suppliers: SupplierBalance[] }>("/api/ledger/ap/suppliers").then(({ ok, data }) => {
      if (ok) setSuppliers(data.suppliers);
    });
  }, [refreshKey]);

  useEffect(() => {
    if (view !== "aging") return;
    api<AgingReport>("/api/ledger/ap/aging").then(({ ok, data }) => {
      if (ok) setAging(data);
    });
  }, [view, refreshKey]);

  if (!suppliers) {
    return <section aria-live="polite" className="rounded-2xl border border-stone-200/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-5 text-sm text-muted-foreground">در حال بارگذاری…</section>;
  }

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className="rounded-2xl border border-stone-200/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-amber-700">تعهدات تأمین‌کنندگان</p>
            <h2 className="mt-1">حساب‌های پرداختنی</h2>
            <p className="mt-1 text-sm text-muted-foreground">مانده حساب‌ها و نمای سنی بدهی تأمین‌کنندگان، بر پایه ثبت‌های فعلی.</p>
          </div>
          <div className="grid min-w-full grid-cols-2 gap-2 sm:min-w-0">
            <button type="button" aria-pressed={view === "balances"} onClick={() => setView("balances")} className={`min-h-12 rounded-xl border px-3 text-sm ${view === "balances" ? "border-amber-200 bg-amber-100 font-semibold text-amber-700" : "border-transparent text-muted-foreground hover:border-stone-200/80 hover:bg-stone-50"}`}>مانده حساب‌ها</button>
            <button type="button" aria-pressed={view === "aging"} onClick={() => setView("aging")} className={`min-h-12 rounded-xl border px-3 text-sm ${view === "aging" ? "border-amber-200 bg-amber-100 font-semibold text-amber-700" : "border-transparent text-muted-foreground hover:border-stone-200/80 hover:bg-stone-50"}`}>نمای سنی بدهی‌ها</button>
          </div>
        </div>

        {view === "balances" ? (
          <div className="mt-5">
            {suppliers.length === 0 ? (
              <p className="rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-8 text-center text-sm text-muted-foreground">هیچ حساب پرداختنی بازی وجود ندارد.</p>
            ) : (
              <>
                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-border"><th className="py-3 pe-3 text-start">تأمین‌کننده</th><th className="py-3 pe-3 text-start">تلفن</th><th className="py-3 pe-3 text-start">مانده</th><th className="py-3 text-start">اقدام</th></tr></thead>
                    <tbody>
                      {suppliers.map((s) => (
                        <tr key={s.supplierId} className="border-b border-border">
                          <td className="py-3 pe-3"><button type="button" onClick={() => setStatementTarget({ id: s.supplierId, name: s.supplierName })} className="font-semibold hover:text-amber-700 hover:underline">{s.supplierName}</button></td>
                          <td className="py-3 pe-3 text-muted-foreground">{s.supplierPhone ? toPersianDigits(s.supplierPhone) : "—"}</td>
                          <td className="whitespace-nowrap py-3 pe-3 font-bold">{money.format(s.balance)}</td>
                          <td className="py-3">{s.supplierId !== "unknown" ? <button type="button" onClick={() => setPayTarget(s)} className="rounded-lg px-3 text-xs font-semibold text-amber-700 hover:bg-amber-100">پرداخت</button> : null}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-3 lg:hidden">
                  {suppliers.map((s) => (
                    <article key={s.supplierId} className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0"><button type="button" onClick={() => setStatementTarget({ id: s.supplierId, name: s.supplierName })} className="truncate text-right font-bold hover:text-amber-700">{s.supplierName}</button><p className="mt-1 text-xs text-muted-foreground">{s.supplierPhone ? toPersianDigits(s.supplierPhone) : "شماره‌ای ثبت نشده"}</p></div>
                        <span className="whitespace-nowrap font-bold">{money.format(s.balance)}</span>
                      </div>
                      {s.supplierId !== "unknown" ? <button type="button" onClick={() => setPayTarget(s)} className="mt-3 rounded-lg bg-amber-100 px-4 text-sm font-semibold text-amber-700">ثبت پرداخت</button> : null}
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
              <p className="rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-8 text-center text-sm text-muted-foreground">هیچ حساب پرداختنی بازی وجود ندارد.</p>
            ) : (
              <>
                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-border"><th className="py-3 pe-3 text-start">تأمین‌کننده</th>{AGING_COLUMNS.map((col) => <th key={col.key} className="py-3 pe-3 text-start">{col.label}</th>)}</tr></thead>
                    <tbody>{aging.rows.map((r) => <tr key={r.supplierId} className="border-b border-border"><td className="py-3 pe-3 font-medium">{r.supplierName}</td>{AGING_COLUMNS.map((col) => <td key={col.key} className={`whitespace-nowrap py-3 pe-3 ${col.key === "total" ? "font-bold" : ""}`}>{r[col.key] ? money.format(r[col.key]) : "—"}</td>)}</tr>)}</tbody>
                    <tfoot><tr className="border-t-2 border-input font-bold"><td className="py-3 pe-3">جمع کل</td>{AGING_COLUMNS.map((col) => <td key={col.key} className="whitespace-nowrap py-3 pe-3">{money.format(aging.totals[col.key])}</td>)}</tr></tfoot>
                  </table>
                </div>
                <div className="space-y-3 lg:hidden">
                  {aging.rows.map((r) => (
                    <article key={r.supplierId} className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
                      <div className="flex justify-between gap-3"><h3>{r.supplierName}</h3><span className="whitespace-nowrap font-bold">{money.format(r.total)}</span></div>
                      <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-stone-100 pt-3 text-sm">
                        {AGING_COLUMNS.filter((col) => col.key !== "total").map((col) => <div key={col.key}><dt className="text-xs text-muted-foreground">{col.label}</dt><dd className="mt-1 font-semibold">{r[col.key] ? money.format(r[col.key]) : "—"}</dd></div>)}
                      </dl>
                    </article>
                  ))}
                  <dl className="rounded-xl border border-stone-200/80 bg-stone-50 p-4"><dt className="text-sm text-muted-foreground">جمع کل حساب‌های پرداختنی</dt><dd className="mt-1 text-lg font-bold">{money.format(aging.totals.total)}</dd></dl>
                </div>
              </>
            )}
          </div>
        )}
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
        className="w-full max-w-md rounded-2xl bg-card p-4 shadow-lg sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 border-b border-border pb-4">
          <p className="text-xs font-semibold text-amber-700">ثبت پرداخت</p>
          <h3 id="pay-bill-heading" className="mt-1 text-lg font-bold">پرداخت به {supplier.supplierName}</h3>
        </header>
        <ErrorBox>{localError}</ErrorBox>
        <div className="space-y-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted-foreground">مبلغ ({money.unitLabel})</span>
            <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted-foreground">روش پرداخت</span>
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
            ثبت پرداخت
          </PrimaryButton>
        </div>
      </section>
    </div>
  );
}
