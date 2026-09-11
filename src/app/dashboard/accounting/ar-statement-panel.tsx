"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api } from "../ui";
import { accountingCustomerHref } from "./accounting-routes";
import { UNKNOWN_CUSTOMER_KEY } from "@/lib/aging";
import { overlayPanelClass } from "../page-chrome";
import { useOverlayEscape } from "./use-overlay-escape";

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
  const money = useMoney();
  const [lines, setLines] = useState<ArStatementLine[] | null>(null);
  useOverlayEscape(onClose);

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
        className={`${overlayPanelClass} max-h-[88vh] w-full max-w-3xl overflow-y-auto p-4 sm:max-h-[80vh] sm:p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">جزئیات حساب</p>
            <h3 id="ar-statement-heading" className="mt-1 text-lg font-bold">صورتحساب {customerName}</h3>
            {/*
              Accounting's own customers slice. Someone looking at a debt can open
              the customer in the ledger (with its accounting code, tax and
              balance) rather than being sent into Growth's marketing projection;
              the canonical record and full 360° file remain owned by CRM. Hidden
              for unattributed A/R lines, which belong to no customer record and
              would link nowhere.
            */}
            {customerId !== UNKNOWN_CUSTOMER_KEY ? (
              <a
                href={accountingCustomerHref(customerId)}
                className="mt-1 inline-block text-xs font-semibold text-primary underline-offset-4 hover:underline"
              >
                مشتریان در حسابداری
              </a>
            ) : null}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-3 py-1 text-sm font-medium text-muted-foreground">
            بستن
          </button>
        </header>

        {lines === null ? (
          <LoadingSkeleton rows={3} />
        ) : lines.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            هنوز فعالیتی برای این مشتری ثبت نشده است.
          </p>
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-xl border border-border/80 lg:block">
              <table className="min-w-[700px] w-full text-sm">
                <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400">
                  <tr className="border-b border-border">
                    <th scope="col" className="px-3 py-3 text-start text-xs font-medium sm:text-sm">تاریخ</th>
                    <th scope="col" className="px-3 py-3 text-start text-xs font-medium sm:text-sm">نوع</th>
                    <th scope="col" className="px-3 py-3 text-start text-xs font-medium sm:text-sm">شرح</th>
                    <th scope="col" className="px-3 py-3 text-start text-xs font-medium sm:text-sm">بدهکار</th>
                    <th scope="col" className="px-3 py-3 text-start text-xs font-medium sm:text-sm">بستانکار</th>
                    <th scope="col" className="px-3 py-3 text-start text-xs font-medium sm:text-sm">مانده</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className="border-b border-border last:border-b-0">
                      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{toPersianDigits(formatJalali(l.date))}</td>
                      <td className="px-3 py-3 text-muted-foreground">{TYPE_LABELS[l.type]}</td>
                      <td className="px-3 py-3 text-foreground">{l.description}</td>
                      <td className="whitespace-nowrap px-3 py-3 font-medium tabular-nums text-foreground">{l.debit ? money.format(l.debit) : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-3 font-medium tabular-nums text-foreground">{l.credit ? money.format(l.credit) : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-3 font-semibold tabular-nums text-foreground">{money.format(l.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 lg:hidden">
              {lines.map((l, i) => (
                <article key={i} className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-muted-foreground">{toPersianDigits(formatJalali(l.date))}</p>
                      <h4 className="mt-1 font-semibold text-foreground">{l.description}</h4>
                    </div>
                    <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{TYPE_LABELS[l.type]}</span>
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">بدهکار</dt>
                      <dd className="mt-1 whitespace-nowrap font-semibold tabular-nums text-foreground">{l.debit ? money.format(l.debit) : "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">بستانکار</dt>
                      <dd className="mt-1 whitespace-nowrap font-semibold tabular-nums text-foreground">{l.credit ? money.format(l.credit) : "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">مانده</dt>
                      <dd className="mt-1 whitespace-nowrap font-bold tabular-nums text-foreground">{money.format(l.balance)}</dd>
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
