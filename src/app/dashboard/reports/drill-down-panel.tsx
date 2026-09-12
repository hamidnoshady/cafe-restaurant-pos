"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api } from "../ui";
import { overlayPanelClass } from "../page-chrome";
import { useOverlayEscape } from "@/app/(app)/accounting/use-overlay-escape";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";

interface DrillDownLine {
  entryId: string;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  debit: number;
  credit: number;
}

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
  // An overlay that ignores Escape is a keyboard trap; see useOverlayEscape.
  useOverlayEscape(onClose);

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
        role="dialog"
        aria-modal="true"
        aria-labelledby="drill-down-title"
        className={`${overlayPanelClass} max-h-[80vh] w-full max-w-2xl overflow-y-auto p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="drill-down-title" className="font-semibold text-foreground">
              {target.accountName}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              اسناد تشکیل‌دهندهٔ این مبلغ — کد حساب {toPersianDigits(target.accountCode)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن"
            className="-me-1 -mt-1 shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        </div>

        {lines === null ? (
          <LoadingSkeleton rows={3} />
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">سندی برای این حساب در این بازه یافت نشد.</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">اسناد حساب {target.accountName}</caption>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th scope="col" className="py-2 pe-3 text-start font-medium">تاریخ</th>
                <th scope="col" className="py-2 pe-3 text-start font-medium">شرح</th>
                <th scope="col" className="py-2 pe-3 text-start font-medium">منبع</th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">بدهکار</th>
                <th scope="col" className="py-2 text-end font-medium">بستانکار</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={`${l.entryId}-${i}`} className="border-b border-border">
                  <td className="py-1.5 pe-3 text-muted-foreground">{toPersianDigits(formatJalali(l.entryDate))}</td>
                  <td className="py-1.5 pe-3">{l.memo ?? "—"}</td>
                  <td className="py-1.5 pe-3 text-muted-foreground">
                    {ledgerSourceLabel(l.sourceType)}
                  </td>
                  <td className="py-1.5 pe-3 text-end tabular-nums">{l.debit ? money.format(l.debit) : "—"}</td>
                  <td className="py-1.5 text-end tabular-nums">{l.credit ? money.format(l.credit) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
