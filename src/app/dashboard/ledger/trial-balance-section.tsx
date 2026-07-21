"use client";

import { useEffect, useState } from "react";
import { formatToman } from "@/lib/money";
import { api } from "../ui";

interface TrialBalanceRow {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  debit: string | number;
  credit: string | number;
}

interface TrialBalanceData {
  accounts: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

const TYPE_LABELS: Record<TrialBalanceRow["type"], string> = {
  asset: "دارایی",
  liability: "بدهی",
  equity: "حقوق صاحبان سرمایه",
  revenue: "درآمد",
  expense: "هزینه",
};

export function TrialBalanceSection({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<TrialBalanceData | null>(null);

  useEffect(() => {
    api<TrialBalanceData>("/api/ledger/trial-balance").then(({ ok, data }) => {
      if (ok) setData(data);
    });
  }, [refreshKey]);

  if (!data) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  const rows = data.accounts.filter((a) => Number(a.debit) !== 0 || Number(a.credit) !== 0);

  return (
    <section className="rounded-2xl bg-card p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">تراز آزمایشی</h2>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            data.balanced ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-destructive/10 text-destructive"
          }`}
        >
          {data.balanced ? "متوازن" : "نامتوازن"}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-start text-muted-foreground">
              <th className="py-2 pe-3 text-start">کد</th>
              <th className="py-2 pe-3 text-start">حساب</th>
              <th className="py-2 pe-3 text-start">نوع</th>
              <th className="py-2 pe-3 text-start">بدهکار</th>
              <th className="py-2 text-start">بستانکار</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="border-b border-border">
                <td className="py-2 pe-3 text-muted-foreground">{a.code}</td>
                <td className="py-2 pe-3">{a.name}</td>
                <td className="py-2 pe-3 text-muted-foreground">{TYPE_LABELS[a.type]}</td>
                <td className="py-2 pe-3">{formatToman(Number(a.debit))}</td>
                <td className="py-2">{formatToman(Number(a.credit))}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-4 text-center text-muted-foreground">
                  هنوز سندی ثبت نشده است.
                </td>
              </tr>
            ) : null}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-input font-semibold">
              <td className="py-2 pe-3" colSpan={3}>
                جمع کل
              </td>
              <td className="py-2 pe-3">{formatToman(data.totalDebit)}</td>
              <td className="py-2">{formatToman(data.totalCredit)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
