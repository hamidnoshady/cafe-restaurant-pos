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
    api<{ lines: ArStatementLine[] }>("/api/ledger/ar/customers/" + customerId).then(({ ok, data }) => {
      if (ok) setLines(data.lines);
    });
  }, [customerId]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="ar-statement-heading"
        className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-card p-4 shadow-lg sm:max-h-[80vh] sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold text-[#9B6700]">جزئیات حساب</p>
            <h3 id="ar-statement-heading" className="mt-1 text-lg font-bold">صورتحساب {customerName}</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground">
            بستن
          </button>
        </header>

        {lines === null ? (
          <p aria-live="polite" className="py-8 text-center text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : lines.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-[#FCFBF8] px-4 py-8 text-center text-sm text-muted-foreground">
            هنوز فعالیتی برای این مشتری ثبت نشده است.
          </p>
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-xl border border-border lg:block">
              <table className="min-w-[700px] w-full text-sm">
                <thead className="bg-[#FCFBF8]">
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
                      <td className="whitespace-nowrap px-3 py-3 tabular-nums">{l.debit ? formatToman(l.debit) : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-3 tabular-nums">{l.credit ? formatToman(l.credit) : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-3 font-semibold tabular-nums">{formatToman(l.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 lg:hidden">
              {lines.map((l, i) => (
                <article key={i} className="rounded-xl border border-border bg-[#FFFEFC] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-muted-foreground">{toPersianDigits(formatJalali(l.date))}</p>
                      <h4 className="mt-1 font-semibold">{l.description}</h4>
                    </div>
                    <span className="rounded-full bg-[#F5F3EE] px-2.5 py-1 text-xs font-medium text-[#5E5B55]">{TYPE_LABELS[l.type]}</span>
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">بدهکار</dt>
                      <dd className="mt-1 whitespace-nowrap font-semibold tabular-nums">{l.debit ? formatToman(l.debit) : "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">بستانکار</dt>
                      <dd className="mt-1 whitespace-nowrap font-semibold tabular-nums">{l.credit ? formatToman(l.credit) : "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">مانده</dt>
                      <dd className="mt-1 whitespace-nowrap font-bold tabular-nums">{formatToman(l.balance)}</dd>
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
