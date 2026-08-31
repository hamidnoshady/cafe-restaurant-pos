"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api } from "../ui";
import { overlayPanelClass } from "../page-chrome";

interface AccountStatementLine {
  entryId: string;
  date: string;
  memo: string | null;
  sourceType: string | null;
  debit: number;
  credit: number;
  balance: number;
}

interface AccountStatement {
  accountCode: string;
  accountName: string;
  normalBalance: "debit" | "credit";
  openingBalance: number;
  lines: AccountStatementLine[];
  closingBalance: number;
}

/**
 * One account's دفتر معین/گردش حساب — opening balance, every movement in
 * the picked range with a running balance, closing balance. Reached from
 * the chart-of-accounts tab (Phase 22 Wave 5, issue #160 §7.3) — the
 * per-report drill-down panel shows a flat list for one figure; this is a
 * browsable statement for one account.
 */
export function AccountStatementPanel({
  accountId,
  accountCode,
  accountName,
  onClose,
}: {
  accountId: string;
  accountCode: string;
  accountName: string;
  onClose: () => void;
}) {
  const money = useMoney();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statement, setStatement] = useState<AccountStatement | null>(null);

  useEffect(() => {
    setStatement(null);
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    api<AccountStatement>(`/api/ledger/accounts/${accountId}/statement?${params}`).then(({ ok, data }) => {
      if (ok) setStatement(data);
    });
  }, [accountId, dateFrom, dateTo]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-statement-heading"
        className={`${overlayPanelClass} max-h-[88vh] w-full max-w-3xl overflow-y-auto p-4 sm:max-h-[80vh] sm:p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold text-amber-700">گردش حساب (دفتر معین)</p>
            <h3 id="account-statement-heading" className="mt-1 text-lg font-bold">
              {accountCode} — {accountName}
            </h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground">
            بستن
          </button>
        </header>

        <div className="grid gap-3 rounded-xl border border-border bg-stone-50 p-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end sm:p-4">
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">از تاریخ</span>
            <JalaliDatePicker value={dateFrom} onChange={setDateFrom} placeholder="از ابتدا" />
          </label>
          <span aria-hidden="true" className="hidden pb-3 text-sm text-muted-foreground sm:block">تا</span>
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">تا تاریخ</span>
            <JalaliDatePicker value={dateTo} onChange={setDateTo} placeholder="تا امروز" />
          </label>
        </div>

        {statement === null ? (
          <LoadingSkeleton rows={3} />
        ) : (
          <div className="mt-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-stone-50 px-4 py-3 text-sm">
              <span className="text-muted-foreground">مانده افتتاحیه</span>
              <span className="font-semibold tabular-nums">{money.format(statement.openingBalance)}</span>
            </div>

            {statement.lines.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-stone-50 px-4 py-8 text-center text-sm text-muted-foreground">
                در این بازه هیچ سندی به این حساب ثبت نشده است.
              </p>
            ) : (
              <>
                <div className="hidden overflow-x-auto rounded-xl border border-border lg:block">
                  <table className="min-w-[700px] w-full text-sm">
                    <thead className="bg-stone-50">
                      <tr className="border-b border-border text-muted-foreground">
                        <th scope="col" className="px-3 py-3 text-start font-semibold">تاریخ</th>
                        <th scope="col" className="px-3 py-3 text-start font-semibold">شرح</th>
                        <th scope="col" className="px-3 py-3 text-start font-semibold">بدهکار</th>
                        <th scope="col" className="px-3 py-3 text-start font-semibold">بستانکار</th>
                        <th scope="col" className="px-3 py-3 text-start font-semibold">مانده</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.lines.map((l) => (
                        <tr key={l.entryId} className="border-b border-border last:border-b-0">
                          <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{toPersianDigits(formatJalali(l.date))}</td>
                          <td className="px-3 py-3">{l.memo ?? "—"}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{l.debit ? money.format(l.debit) : "—"}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{l.credit ? money.format(l.credit) : "—"}</td>
                          <td className="whitespace-nowrap px-3 py-3 font-semibold tabular-nums">{money.format(l.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="space-y-3 lg:hidden">
                  {statement.lines.map((l) => (
                    <article key={l.entryId} className="rounded-xl border border-border bg-stone-50 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="text-xs text-muted-foreground">{toPersianDigits(formatJalali(l.date))}</p>
                      </div>
                      <h4 className="mt-1 font-semibold">{l.memo ?? "—"}</h4>
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

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-stone-50 px-4 py-3 text-sm">
              <span className="text-muted-foreground">مانده اختتامیه</span>
              <span className="font-bold tabular-nums">{money.format(statement.closingBalance)}</span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
