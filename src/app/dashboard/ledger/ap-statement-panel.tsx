"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api } from "../ui";
import { overlayPanelClass } from "../page-chrome";

interface ApStatementLine {
  date: string;
  type: "bill" | "payment" | "return" | "other";
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

const TYPE_LABELS: Record<ApStatementLine["type"], string> = {
  bill: "فاکتور",
  payment: "پرداخت",
  return: "برگشت",
  other: "سایر",
};

/** A supplier's full AP activity (bills + payments + returns) with a running balance. */
export function ApStatementPanel({
  supplierId,
  supplierName,
  onClose,
}: {
  supplierId: string;
  supplierName: string;
  onClose: () => void;
}) {
  const money = useMoney();
  const [lines, setLines] = useState<ApStatementLine[] | null>(null);

  useEffect(() => {
    setLines(null);
    api<{ lines: ApStatementLine[] }>("/api/ledger/ap/suppliers/" + supplierId).then(({ ok, data }) => {
      if (ok) setLines(data.lines);
    });
  }, [supplierId]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="ap-statement-heading"
        className={`${overlayPanelClass} max-h-[88vh] w-full max-w-3xl overflow-y-auto p-4 sm:max-h-[80vh] sm:p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold text-amber-700">جزئیات حساب</p>
            <h3 id="ap-statement-heading" className="mt-1 text-lg font-bold">صورتحساب {supplierName}</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground">
            بستن
          </button>
        </header>

        {lines === null ? (
          <LoadingSkeleton rows={3} />
        ) : lines.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-stone-50 px-4 py-8 text-center text-sm text-muted-foreground">
            هنوز فعالیتی برای این تأمین‌کننده ثبت نشده است.
          </p>
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-xl border border-border lg:block">
              <table className="min-w-[700px] w-full text-sm">
                <thead className="bg-stone-50">
                  <tr className="border-b border-border text-muted-foreground">
                    <th scope="col" className="px-3 py-3 text-start font-semibold">تاریخ</th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">نوع</th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">شرح</th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">بدهکار</th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">بستانکار</th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">مانده</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className="border-b border-border last:border-b-0">
                      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{toPersianDigits(formatJalali(l.date))}</td>
                      <td className="px-3 py-3 text-muted-foreground">{TYPE_LABELS[l.type]}</td>
                      <td className="px-3 py-3">{l.description}</td>
                      <td className="whitespace-nowrap px-3 py-3 tabular-nums">{l.debit ? money.format(l.debit) : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-3 tabular-nums">{l.credit ? money.format(l.credit) : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-3 font-semibold tabular-nums">{money.format(l.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 lg:hidden">
              {lines.map((l, i) => (
                <article key={i} className="rounded-xl border border-border bg-stone-50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-muted-foreground">{toPersianDigits(formatJalali(l.date))}</p>
                      <h4 className="mt-1 font-semibold">{l.description}</h4>
                    </div>
                    <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">{TYPE_LABELS[l.type]}</span>
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">بدهکار</dt>
                      <dd className="mt-1 whitespace-nowrap font-semibold tabular-nums">{l.debit ? money.format(l.debit) : "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">بستانکار</dt>
                      <dd className="mt-1 whitespace-nowrap font-semibold tabular-nums">{l.credit ? money.format(l.credit) : "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">مانده</dt>
                      <dd className="mt-1 whitespace-nowrap font-bold tabular-nums">{money.format(l.balance)}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
