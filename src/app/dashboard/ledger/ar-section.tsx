"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman, parseToRial, rialToToman } from "@/lib/money";
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

  if (!customers) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className="rounded-2xl bg-card p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">حساب‌های دریافتنی</h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setView("balances")}
              className={`rounded-lg px-3 py-1.5 text-sm ${view === "balances" ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted"}`}
            >
              مانده حساب‌ها
            </button>
            <button
              type="button"
              onClick={() => setView("aging")}
              className={`rounded-lg px-3 py-1.5 text-sm ${view === "aging" ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted"}`}
            >
              نمای سنی بدهی‌ها
            </button>
          </div>
        </div>

        {view === "balances" ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="py-2 pe-3 text-start">مشتری</th>
                  <th className="py-2 pe-3 text-start">تلفن</th>
                  <th className="py-2 pe-3 text-start">مانده</th>
                  <th className="py-2 text-start">اقدام</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.customerId} className="border-b border-border">
                    <td className="py-2 pe-3">
                      <button
                        type="button"
                        onClick={() => setStatementTarget({ id: c.customerId, name: c.customerName })}
                        className="hover:underline"
                      >
                        {c.customerName}
                      </button>
                    </td>
                    <td className="py-2 pe-3 text-muted-foreground">{c.customerPhone ? toPersianDigits(c.customerPhone) : "—"}</td>
                    <td className="py-2 pe-3 tabular-nums font-semibold">{formatToman(c.balance)}</td>
                    <td className="py-2">
                      {c.customerId !== "unknown" ? (
                        <button
                          type="button"
                          onClick={() => setReceiveTarget(c)}
                          className="rounded-lg px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10"
                        >
                          دریافت وجه
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {customers.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-4 text-center text-muted-foreground">
                      هیچ حساب دریافتنی بازی وجود ندارد.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            {!aging ? (
              <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-2 pe-3 text-start">مشتری</th>
                    {AGING_COLUMNS.map((col) => (
                      <th key={col.key} className="py-2 pe-3 text-start">
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {aging.rows.map((r) => (
                    <tr key={r.customerId} className="border-b border-border">
                      <td className="py-2 pe-3">{r.customerName}</td>
                      {AGING_COLUMNS.map((col) => (
                        <td key={col.key} className={`py-2 pe-3 tabular-nums ${col.key === "total" ? "font-semibold" : ""}`}>
                          {r[col.key] ? formatToman(r[col.key]) : "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {aging.rows.length === 0 ? (
                    <tr>
                      <td colSpan={AGING_COLUMNS.length + 1} className="py-4 text-center text-muted-foreground">
                        هیچ حساب دریافتنی بازی وجود ندارد.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-input font-semibold">
                    <td className="py-2 pe-3">جمع کل</td>
                    {AGING_COLUMNS.map((col) => (
                      <td key={col.key} className="py-2 pe-3 tabular-nums">
                        {formatToman(aging.totals[col.key])}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        )}
      </div>

      {statementTarget ? (
        <ArStatementPanel
          customerId={statementTarget.id}
          customerName={statementTarget.name}
          onClose={() => setStatementTarget(null)}
        />
      ) : null}

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
  const [amount, setAmount] = useState(String(rialToToman(Math.max(customer.balance, 0)) || ""));
  const [method, setMethod] = useState<"cash" | "bank">("cash");
  const [memo, setMemo] = useState("");
  const [localError, setLocalError] = useState("");

  async function submit() {
    let rial: number;
    try {
      rial = parseToRial(amount, "toman");
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 font-semibold">دریافت وجه از {customer.customerName}</h3>
        <ErrorBox>{localError}</ErrorBox>
        <div className="space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">مبلغ (تومان)</span>
            <input className={inputClass} dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">روش دریافت</span>
            <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value as "cash" | "bank")}>
              <option value="cash">نقدی</option>
              <option value="bank">بانکی</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">شرح (اختیاری)</span>
            <input className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <SecondaryButton onClick={onClose} disabled={busy}>
            انصراف
          </SecondaryButton>
          <PrimaryButton onClick={submit} disabled={busy}>
            ثبت دریافت
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
