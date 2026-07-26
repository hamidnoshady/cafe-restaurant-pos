"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatToman } from "@/lib/money";
import { api } from "../ui";

interface ArStatementLine {
  date: string;
  type: "invoice" | "receipt" | "other";
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

const TYPE_LABELS: Record<ArStatementLine["type"], string> = {
  invoice: "فاکتور",
  receipt: "دریافت",
  other: "سایر",
};

/** A customer's full AR activity (invoices + receipts) with a running balance — "what makes up this customer's number." */
export function ArStatementPanel({
  customerId,
  customerName,
  onClose,
}: {
  customerId: string;
  customerName: string;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<ArStatementLine[] | null>(null);

  useEffect(() => {
    setLines(null);
    api<{ lines: ArStatementLine[] }>(`/api/ledger/ar/customers/${customerId}`).then(({ ok, data }) => {
      if (ok) setLines(data.lines);
    });
  }, [customerId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold">صورتحساب {customerName}</h3>
          <button type="button" onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">
            بستن ✕
          </button>
        </div>

        {lines === null ? (
          <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز فعالیتی برای این مشتری ثبت نشده است.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-2 pe-3 text-start">تاریخ</th>
                <th className="py-2 pe-3 text-start">نوع</th>
                <th className="py-2 pe-3 text-start">شرح</th>
                <th className="py-2 pe-3 text-start">بدهکار</th>
                <th className="py-2 pe-3 text-start">بستانکار</th>
                <th className="py-2 text-start">مانده</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-b border-border">
                  <td className="py-1.5 pe-3 text-muted-foreground">{toPersianDigits(formatJalali(l.date))}</td>
                  <td className="py-1.5 pe-3 text-muted-foreground">{TYPE_LABELS[l.type]}</td>
                  <td className="py-1.5 pe-3">{l.description}</td>
                  <td className="py-1.5 pe-3 tabular-nums">{l.debit ? formatToman(l.debit) : "—"}</td>
                  <td className="py-1.5 pe-3 tabular-nums">{l.credit ? formatToman(l.credit) : "—"}</td>
                  <td className="py-1.5 tabular-nums font-semibold">{formatToman(l.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
