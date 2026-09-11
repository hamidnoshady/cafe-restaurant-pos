"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api } from "../ui";
import { overlayPanelClass } from "../page-chrome";
import { useOverlayEscape } from "./use-overlay-escape";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";

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
  const [error, setError] = useState("");
  useOverlayEscape(onClose);

  useEffect(() => {
    setStatement(null);
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    setError("");
    api<AccountStatement>(`/api/ledger/accounts/${accountId}/statement?${params}`).then(({ ok, data }) => {
      if (ok) setStatement(data);
      else setError("بارگذاری گردش این حساب ناموفق بود.");
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
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">گردش حساب (دفتر معین)</p>
            <h3 id="account-statement-heading" className="mt-1 text-lg font-bold">
              {accountCode} — {accountName}
            </h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-3 py-1 text-sm font-medium text-muted-foreground">
            بستن
          </button>
        </header>

        <div className="grid gap-3 rounded-xl border border-border/80 bg-stone-50/60 p-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end sm:p-4 dark:bg-stone-800/30">
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

        {error ? (
          <p role="alert" className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : statement === null ? (
          <LoadingSkeleton rows={3} />
        ) : (
          <div className="mt-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-stone-50/60 px-4 py-3 text-sm dark:bg-stone-800/30">
              <span className="text-muted-foreground">مانده افتتاحیه</span>
              <span className="font-semibold tabular-nums text-foreground">{money.format(statement.openingBalance)}</span>
            </div>

            {statement.lines.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                در این بازه هیچ سندی به این حساب ثبت نشده است.
              </p>
            ) : (
              <>
                <div className="hidden overflow-x-auto rounded-xl border border-border/80 lg:block">
                  <table className="min-w-[700px] w-full text-sm">
                    <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400">
                      <tr className="border-b border-border">
                        <th scope="col" className="px-3 py-3 text-start text-xs font-medium sm:text-sm">تاریخ</th>
                        <th scope="col" className="px-3 py-3 text-start text-xs font-medium sm:text-sm">شرح</th>
                        <th scope="col" className="px-3 py-3 text-start text-xs font-medium sm:text-sm">بدهکار</th>
                        <th scope="col" className="px-3 py-3 text-start text-xs font-medium sm:text-sm">بستانکار</th>
                        <th scope="col" className="px-3 py-3 text-start text-xs font-medium sm:text-sm">مانده</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* An entry can post two lines to the same account, so the
                          entry id alone is not a unique key. */}
                      {statement.lines.map((l, i) => (
                        <tr key={`${l.entryId}-${i}`} className="border-b border-border last:border-b-0">
                          <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{toPersianDigits(formatJalali(l.date))}</td>
                          <td className="px-3 py-3 text-foreground">
                            {l.memo ?? "—"}
                            {/* `sourceType` was fetched and then dropped; naming what
                                posted a line is most of what makes a معین readable. */}
                            <span className="ms-2 text-xs text-muted-foreground">{ledgerSourceLabel(l.sourceType)}</span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-3 font-medium tabular-nums text-foreground">{l.debit ? money.format(l.debit) : "—"}</td>
                          <td className="whitespace-nowrap px-3 py-3 font-medium tabular-nums text-foreground">{l.credit ? money.format(l.credit) : "—"}</td>
                          <td className="whitespace-nowrap px-3 py-3 font-semibold tabular-nums text-foreground">{money.format(l.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="space-y-3 lg:hidden">
                  {statement.lines.map((l, i) => (
                    <article key={`${l.entryId}-${i}`} className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="text-xs text-muted-foreground">{toPersianDigits(formatJalali(l.date))}</p>
                      </div>
                      <h4 className="mt-1 font-semibold text-foreground">{l.memo ?? "—"}</h4>
                      <p className="mt-0.5 text-xs text-muted-foreground">{ledgerSourceLabel(l.sourceType)}</p>
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

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-stone-50/60 px-4 py-3 text-sm dark:bg-stone-800/30">
              <span className="text-muted-foreground">مانده اختتامیه</span>
              <span className="font-bold tabular-nums text-foreground">{money.format(statement.closingBalance)}</span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
