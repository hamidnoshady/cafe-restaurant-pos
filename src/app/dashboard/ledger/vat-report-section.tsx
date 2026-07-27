"use client";

import { useEffect, useState } from "react";
import { formatToman } from "@/lib/money";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api } from "../ui";

interface VatReport {
  periodFrom: string | null;
  periodTo: string | null;
  outputVat: number;
  inputVat: number;
  netPayable: number;
  vatPayableBalance: number;
  vatReceivableBalance: number;
}

/**
 * Output vs input VAT and the net payable position. Output VAT is
 * auto-posted (every order); input VAT is whatever's been recorded via a
 * manual journal entry against "مالیات بر ارزش افزوده خرید" (see the "ثبت
 * سند دستی" tab) — this is a read-only summary of both control accounts'
 * movements, not a new place to enter anything.
 */
export function VatReportSection({ refreshKey }: { refreshKey: number }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [report, setReport] = useState<VatReport | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    api<{ report: VatReport }>(`/api/ledger/vat?${params}`).then(({ ok, data }) => {
      if (ok) setReport(data.report);
    });
  }, [dateFrom, dateTo, refreshKey]);

  return (
    <section className="rounded-2xl bg-card p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">گزارش مالیات بر ارزش افزوده</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-36">
            <JalaliDatePicker value={dateFrom} onChange={setDateFrom} placeholder="از تاریخ" />
          </div>
          <span className="text-xs text-muted-foreground">تا</span>
          <div className="w-36">
            <JalaliDatePicker value={dateTo} onChange={setDateTo} placeholder="تا تاریخ" />
          </div>
        </div>
      </div>

      {!report ? (
        <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            مالیات ستانده از فروش (خودکار) در برابر مالیات پرداختی بابت خرید (ثبت‌شده با سند دستی)، برای بازه انتخاب‌شده.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">مالیات ستانده (فروش)</p>
              <p className="mt-1 text-lg font-semibold">{formatToman(report.outputVat)}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">مالیات پرداختی (خرید)</p>
              <p className="mt-1 text-lg font-semibold">{formatToman(report.inputVat)}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">
                {report.netPayable >= 0 ? "خالص قابل پرداخت" : "خالص قابل استرداد"}
              </p>
              <p className={`mt-1 text-lg font-semibold ${report.netPayable >= 0 ? "" : "text-emerald-700 dark:text-emerald-400"}`}>
                {formatToman(Math.abs(report.netPayable))}
              </p>
            </div>
          </div>

          <div className="border-t border-border pt-3">
            <p className="mb-2 text-xs text-muted-foreground">مانده تجمعی حساب‌ها (تا پایان بازه)</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
                <span className="text-muted-foreground">مالیات بر ارزش افزوده پرداختنی</span>
                <span className="font-semibold">{formatToman(report.vatPayableBalance)}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
                <span className="text-muted-foreground">مالیات بر ارزش افزوده خرید (قابل استرداد)</span>
                <span className="font-semibold">{formatToman(report.vatReceivableBalance)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
