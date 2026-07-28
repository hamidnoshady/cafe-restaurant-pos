"use client";

import { useState, type ReactNode } from "react";
import { formatToman } from "@/lib/money";
import { DrillDownPanel, type DrillDownTarget } from "./drill-down-panel";

interface PnlLine {
  accountCode: string;
  accountName: string;
  amount: number;
}

export interface ProfitAndLoss {
  revenue: PnlLine[];
  expenses: PnlLine[];
  totalRevenue: number;
  totalExpenses: number;
  netIncome: number;
  costOfSales: number;
  grossProfit: number;
  laborCost: number;
  primeCost: number;
  operatingExpenses: number;
}

export interface BalanceSheet {
  assets: PnlLine[];
  liabilities: PnlLine[];
  equity: PnlLine[];
  retainedEarnings: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanced: boolean;
}

export interface CashFlowLine {
  sourceType: string;
  label: string;
  amount: number;
}

export interface CashFlow {
  openingCash: number;
  closingCash: number;
  netChange: number;
  lines: CashFlowLine[];
}

export interface Comparison<T> {
  current: T;
  previous: T | null;
}

function isComparison<T>(report: T | Comparison<T>): report is Comparison<T> {
  return typeof report === "object" && report !== null && "current" in report;
}

interface DrillContext {
  dateFrom?: string;
  dateTo?: string;
  onDrillDown: (accountCode: string, accountName: string) => void;
}

function previousAmount(previous: PnlLine[] | undefined, code: string): number | null {
  if (!previous) return null;
  return previous.find((l) => l.accountCode === code)?.amount ?? 0;
}

function Section({
  heading,
  lines,
  previousLines,
  total,
  previousTotal,
  totalLabel,
  drill,
}: {
  heading: string;
  lines: PnlLine[];
  previousLines?: PnlLine[];
  total: number;
  previousTotal?: number | null;
  totalLabel: string;
  drill?: DrillContext;
}) {
  const showPrevious = previousLines !== undefined;
  return (
    <div className="mb-4">
      <h3 className="mb-2 font-semibold">{heading}</h3>
      <table className="w-full text-sm">
        <tbody>
          {lines.map((l) => {
            const prev = showPrevious ? previousAmount(previousLines, l.accountCode) : null;
            const clickable = !!drill && !!l.accountCode;
            return (
              <tr
                key={l.accountCode || l.accountName}
                className={`border-b border-border ${clickable ? "cursor-pointer hover:bg-muted" : ""}`}
                onClick={clickable ? () => drill!.onDrillDown(l.accountCode, l.accountName) : undefined}
              >
                <td className="py-1.5 pe-3 text-muted-foreground">{l.accountCode}</td>
                <td className="py-1.5 pe-3">{l.accountName}</td>
                <td className="py-1.5 text-end tabular-nums">{formatToman(l.amount)}</td>
                {showPrevious ? (
                  <td className="py-1.5 ps-3 text-end tabular-nums text-muted-foreground">
                    {prev !== null ? formatToman(prev) : "—"}
                  </td>
                ) : null}
              </tr>
            );
          })}
          {lines.length === 0 ? (
            <tr>
              <td colSpan={showPrevious ? 4 : 3} className="py-2 text-center text-muted-foreground">
                بدون سطر
              </td>
            </tr>
          ) : null}
          <tr className="border-t-2 border-input font-semibold">
            <td className="py-1.5 pe-3" colSpan={2}>
              {totalLabel}
            </td>
            <td className="py-1.5 text-end tabular-nums">{formatToman(total)}</td>
            {showPrevious ? (
              <td className="py-1.5 ps-3 text-end tabular-nums text-muted-foreground">
                {previousTotal != null ? formatToman(previousTotal) : "—"}
              </td>
            ) : null}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function SummaryStat({ label, value, previous }: { label: string; value: number; previous?: number | null }) {
  return (
    <div className="rounded-xl bg-muted px-4 py-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={`font-semibold tabular-nums ${value < 0 ? "text-destructive" : ""}`}>{formatToman(value)}</div>
      {previous != null ? (
        <div className="text-xs text-muted-foreground">دورهٔ قبل: {formatToman(previous)}</div>
      ) : null}
    </div>
  );
}

/** Owns the drill-down panel's open/close state, so every statement view opens the same overlay the same way. */
function useDrillDown(dateFrom?: string, dateTo?: string): { drill: DrillContext; panel: ReactNode } {
  const [target, setTarget] = useState<DrillDownTarget | null>(null);
  const drill: DrillContext = {
    dateFrom,
    dateTo,
    onDrillDown: (accountCode, accountName) => setTarget({ accountCode, accountName, dateFrom, dateTo }),
  };
  const panel = target ? <DrillDownPanel target={target} onClose={() => setTarget(null)} /> : null;
  return { drill, panel };
}

export function ProfitAndLossView({
  report,
  dateFrom,
  dateTo,
}: {
  report: ProfitAndLoss | Comparison<ProfitAndLoss>;
  dateFrom?: string;
  dateTo?: string;
}) {
  const current = isComparison(report) ? report.current : report;
  const previous = isComparison(report) ? report.previous : null;
  const { drill, panel } = useDrillDown(dateFrom, dateTo);

  return (
    <div>
      <Section
        heading="درآمدها"
        lines={current.revenue}
        previousLines={previous?.revenue}
        total={current.totalRevenue}
        previousTotal={previous?.totalRevenue}
        totalLabel="جمع درآمدها"
        drill={drill}
      />
      <Section
        heading="هزینه‌ها"
        lines={current.expenses}
        previousLines={previous?.expenses}
        total={current.totalExpenses}
        previousTotal={previous?.totalExpenses}
        totalLabel="جمع هزینه‌ها"
        drill={drill}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SummaryStat
          label="بهای تمام‌شده کالای فروش‌رفته (COGS)"
          value={current.costOfSales}
          previous={previous?.costOfSales}
        />
        <SummaryStat label="سود ناخالص" value={current.grossProfit} previous={previous?.grossProfit} />
        <SummaryStat label="هزینه نیروی انسانی" value={current.laborCost} previous={previous?.laborCost} />
        <SummaryStat label="بهای اولیه (Prime Cost)" value={current.primeCost} previous={previous?.primeCost} />
        <SummaryStat
          label="سایر هزینه‌های عملیاتی"
          value={current.operatingExpenses}
          previous={previous?.operatingExpenses}
        />
      </div>
      <div className="mt-4 flex items-center justify-between rounded-xl bg-muted px-4 py-3 font-bold">
        <span>سود (زیان) خالص</span>
        <div className="flex items-center gap-3">
          {previous ? (
            <span className="text-sm font-normal text-muted-foreground">
              دورهٔ قبل: {formatToman(previous.netIncome)}
            </span>
          ) : null}
          <span className={current.netIncome < 0 ? "text-destructive" : ""}>{formatToman(current.netIncome)}</span>
        </div>
      </div>
      {panel}
    </div>
  );
}

export function BalanceSheetView({
  report,
  dateTo,
}: {
  report: BalanceSheet | Comparison<BalanceSheet>;
  dateTo?: string;
}) {
  const current = isComparison(report) ? report.current : report;
  const previous = isComparison(report) ? report.previous : null;
  const { drill, panel } = useDrillDown(undefined, dateTo);

  const equityLines = [...current.equity, { accountCode: "", accountName: "سود انباشته (جاری)", amount: current.retainedEarnings }];
  const previousEquityLines = previous
    ? [...previous.equity, { accountCode: "", accountName: "سود انباشته (جاری)", amount: previous.retainedEarnings }]
    : undefined;

  return (
    <div>
      <Section
        heading="دارایی‌ها"
        lines={current.assets}
        previousLines={previous?.assets}
        total={current.totalAssets}
        previousTotal={previous?.totalAssets}
        totalLabel="جمع دارایی‌ها"
        drill={drill}
      />
      <Section
        heading="بدهی‌ها"
        lines={current.liabilities}
        previousLines={previous?.liabilities}
        total={current.totalLiabilities}
        previousTotal={previous?.totalLiabilities}
        totalLabel="جمع بدهی‌ها"
        drill={drill}
      />
      <Section
        heading="حقوق صاحبان سرمایه"
        lines={equityLines}
        previousLines={previousEquityLines}
        total={current.totalEquity}
        previousTotal={previous?.totalEquity}
        totalLabel="جمع حقوق صاحبان سرمایه"
        drill={drill}
      />
      <div className="mt-4 flex items-center justify-between rounded-xl bg-muted px-4 py-3 font-bold">
        <span>وضعیت تراز</span>
        <span className={current.balanced ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}>
          {current.balanced ? "متوازن" : "نامتوازن"}
        </span>
      </div>
      {panel}
    </div>
  );
}

export function CashFlowView({ report }: { report: CashFlow | Comparison<CashFlow> }) {
  const current = isComparison(report) ? report.current : report;
  const previous = isComparison(report) ? report.previous : null;

  return (
    <div>
      <div className="mb-4">
        <h3 className="mb-2 font-semibold">گردش وجوه نقد بر اساس نوع رویداد</h3>
        <table className="w-full text-sm">
          <tbody>
            {current.lines.map((l) => {
              const prev = previous?.lines.find((p) => p.sourceType === l.sourceType)?.amount ?? null;
              return (
                <tr key={l.sourceType} className="border-b border-border">
                  <td className="py-1.5 pe-3">{l.label}</td>
                  <td className="py-1.5 text-end tabular-nums">{formatToman(l.amount)}</td>
                  {previous ? (
                    <td className="py-1.5 ps-3 text-end tabular-nums text-muted-foreground">
                      {prev !== null ? formatToman(prev) : "—"}
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {current.lines.length === 0 ? (
              <tr>
                <td colSpan={previous ? 3 : 2} className="py-2 text-center text-muted-foreground">
                  بدون رویداد نقدی
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="space-y-2 rounded-xl bg-muted px-4 py-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">موجودی ابتدای دوره</span>
          <span className="tabular-nums">{formatToman(current.openingCash)}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">موجودی پایان دوره</span>
          <span className="tabular-nums">{formatToman(current.closingCash)}</span>
        </div>
        <div className="flex items-center justify-between border-t border-input pt-2 font-bold">
          <span>تغییر خالص وجه نقد</span>
          <span className={current.netChange < 0 ? "text-destructive" : ""}>{formatToman(current.netChange)}</span>
        </div>
      </div>
    </div>
  );
}
