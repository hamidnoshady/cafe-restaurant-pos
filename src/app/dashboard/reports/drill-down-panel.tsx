"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api } from "../ui";
import { overlayPanelClass } from "../page-chrome";

interface DrillDownLine {
  entryId: string;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  debit: number;
  credit: number;
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  order: "سفارش",
  purchase: "خرید",
  waste: "ضایعات",
  stock_count: "شمارش موجودی",
  customer_return: "بازپرداخت مشتری",
  manual: "سند دستی",
};

export interface DrillDownTarget {
  accountCode: string;
  accountName: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * "Drill down to the journal entries behind any figure" (Phase 16 exit
 * criterion): a lightweight overlay listing every posting that composes one
 * account's amount in a statement, opened by clicking that line.
 */
export function DrillDownPanel({ target, onClose }: { target: DrillDownTarget; onClose: () => void }) {
  const money = useMoney();
  const [lines, setLines] = useState<DrillDownLine[] | null>(null);

  useEffect(() => {
    setLines(null);
    const params = new URLSearchParams({ accountCode: target.accountCode });
    if (target.dateFrom) params.set("dateFrom", target.dateFrom);
    if (target.dateTo) params.set("dateTo", target.dateTo);
    api<{ lines: DrillDownLine[] }>(`/api/reports/drill-down?${params}`).then(({ ok, data }) => {
      if (ok) setLines(data.lines);
    });
  }, [target.accountCode, target.dateFrom, target.dateTo]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className={`${overlayPanelClass} max-h-[80vh] w-full max-w-2xl overflow-y-auto p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold">{target.accountName}</h3>
          <button type="button" onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">
            بستن ✕
          </button>
        </div>

        {lines === null ? (
          <LoadingSkeleton rows={3} />
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">سندی برای این حساب در این بازه یافت نشد.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-2 pe-3 text-start">تاریخ</th>
                <th className="py-2 pe-3 text-start">شرح</th>
                <th className="py-2 pe-3 text-start">منبع</th>
                <th className="py-2 pe-3 text-start">بدهکار</th>
                <th className="py-2 text-start">بستانکار</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={`${l.entryId}-${i}`} className="border-b border-border">
                  <td className="py-1.5 pe-3 text-muted-foreground">{toPersianDigits(formatJalali(l.entryDate))}</td>
                  <td className="py-1.5 pe-3">{l.memo ?? "—"}</td>
                  <td className="py-1.5 pe-3 text-muted-foreground">
                    {(l.sourceType && SOURCE_TYPE_LABELS[l.sourceType]) ?? l.sourceType ?? "—"}
                  </td>
                  <td className="py-1.5 pe-3 tabular-nums">{l.debit ? money.format(l.debit) : "—"}</td>
                  <td className="py-1.5 tabular-nums">{l.credit ? money.format(l.credit) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
