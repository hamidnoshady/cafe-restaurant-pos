"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman, parseToRial, rialToToman } from "@/lib/money";
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

  if (!suppliers) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className="rounded-2xl bg-card p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">حساب‌های پرداختنی</h2>
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
                  <th className="py-2 pe-3 text-start">تأمین‌کننده</th>
                  <th className="py-2 pe-3 text-start">تلفن</th>
                  <th className="py-2 pe-3 text-start">مانده</th>
                  <th className="py-2 text-start">اقدام</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr key={s.supplierId} className="border-b border-border">
                    <td className="py-2 pe-3">
                      <button
                        type="button"
                        onClick={() => setStatementTarget({ id: s.supplierId, name: s.supplierName })}
                        className="hover:underline"
                      >
                        {s.supplierName}
                      </button>
                    </td>
                    <td className="py-2 pe-3 text-muted-foreground">{s.supplierPhone ? toPersianDigits(s.supplierPhone) : "—"}</td>
                    <td className="py-2 pe-3 tabular-nums font-semibold">{formatToman(s.balance)}</td>
                    <td className="py-2">
                      {s.supplierId !== "unknown" ? (
                        <button
                          type="button"
                          onClick={() => setPayTarget(s)}
                          className="rounded-lg px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10"
                        >
                          پرداخت
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {suppliers.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-4 text-center text-muted-foreground">
                      هیچ حساب پرداختنی بازی وجود ندارد.
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
                    <th className="py-2 pe-3 text-start">تأمین‌کننده</th>
                    {AGING_COLUMNS.map((col) => (
                      <th key={col.key} className="py-2 pe-3 text-start">
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {aging.rows.map((r) => (
                    <tr key={r.supplierId} className="border-b border-border">
                      <td className="py-2 pe-3">{r.supplierName}</td>
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
                        هیچ حساب پرداختنی بازی وجود ندارد.
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
        <ApStatementPanel
          supplierId={statementTarget.id}
          supplierName={statementTarget.name}
          onClose={() => setStatementTarget(null)}
        />
      ) : null}

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
  const [amount, setAmount] = useState(String(rialToToman(Math.max(supplier.balance, 0)) || ""));
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
    await onSubmit({ supplierId: supplier.supplierId, amount: rial, method, memo: memo.trim() || undefined });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 font-semibold">پرداخت به {supplier.supplierName}</h3>
        <ErrorBox>{localError}</ErrorBox>
        <div className="space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">مبلغ (تومان)</span>
            <input className={inputClass} dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">روش پرداخت</span>
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
            ثبت پرداخت
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
