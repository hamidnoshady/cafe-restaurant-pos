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

function previousAmount(
  previous: PnlLine[] | undefined,
  code: string,
): number | null {
  if (!previous) return null;
  return previous.find((line) => line.accountCode === code)?.amount ?? 0;
}

function ReportLineName({
  line,
  drill,
}: {
  line: PnlLine;
  drill?: DrillContext;
}) {
  const clickable = Boolean(drill && line.accountCode);

  if (!clickable)
    return (
      <span className="font-semibold text-[#252522]">{line.accountName}</span>
    );

  return (
    <button
      type="button"
      onClick={() => drill!.onDrillDown(line.accountCode, line.accountName)}
      className="min-h-10 rounded-lg px-1 text-start font-semibold text-[#252522] underline-offset-4 hover:text-[#8A5C00] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45"
    >
      {line.accountName}
    </button>
  );
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
    <section className="border-b border-[#F0EEE9] py-5 first:pt-0 last:border-b-0">
      <h3 className="mb-3 text-base font-bold text-[#252522]">{heading}</h3>

      <div className="hidden overflow-hidden rounded-xl border border-[#EEECE7] sm:block">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">{heading}</caption>
            <thead className="bg-[#FCFBF8] text-[#77756F]">
              <tr className="border-b border-[#EEECE7]">
                <th
                  scope="col"
                  className="px-4 py-3 text-start text-xs font-semibold"
                >
                  کد
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-start text-xs font-semibold"
                >
                  حساب
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-end text-xs font-semibold"
                >
                  مبلغ
                </th>
                {showPrevious ? (
                  <th
                    scope="col"
                    className="px-4 py-3 text-end text-xs font-semibold"
                  >
                    دورهٔ قبل
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const previousValue = showPrevious
                  ? previousAmount(previousLines, line.accountCode)
                  : null;
                return (
                  <tr
                    key={line.accountCode || line.accountName}
                    className="border-b border-[#F0EEE9] last:border-b-0"
                  >
                    <td className="px-4 py-3.5 text-[#77756F]">
                      {line.accountCode || "—"}
                    </td>
                    <td className="px-4 py-3.5">
                      <ReportLineName line={line} drill={drill} />
                    </td>
                    <td className="px-4 py-3.5 text-end tabular-nums font-medium text-[#252522]">
                      {formatToman(line.amount)}
                    </td>
                    {showPrevious ? (
                      <td className="px-4 py-3.5 text-end tabular-nums text-[#77756F]">
                        {previousValue !== null
                          ? formatToman(previousValue)
                          : "—"}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
              {lines.length === 0 ? (
                <tr>
                  <td
                    colSpan={showPrevious ? 4 : 3}
                    className="px-4 py-8 text-center text-sm text-[#77756F]"
                  >
                    بدون سطر
                  </td>
                </tr>
              ) : null}
            </tbody>
            <tfoot className="bg-[#FCFBF8]">
              <tr className="border-t-2 border-[#DEDAD2] font-bold text-[#252522]">
                <th scope="row" className="px-4 py-3.5 text-start" colSpan={2}>
                  {totalLabel}
                </th>
                <td className="px-4 py-3.5 text-end tabular-nums">
                  {formatToman(total)}
                </td>
                {showPrevious ? (
                  <td className="px-4 py-3.5 text-end tabular-nums text-[#77756F]">
                    {previousTotal != null ? formatToman(previousTotal) : "—"}
                  </td>
                ) : null}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="space-y-2 sm:hidden">
        {lines.map((line) => {
          const previousValue = showPrevious
            ? previousAmount(previousLines, line.accountCode)
            : null;
          return (
            <article
              key={line.accountCode || line.accountName}
              className="rounded-xl border border-[#EEECE7] bg-[#FFFEFC] p-4"
            >
              <div className="flex items-start gap-3">
                <span className="mt-1 shrink-0 text-xs font-medium text-[#77756F]">
                  {line.accountCode || "—"}
                </span>
                <div className="min-w-0 flex-1">
                  <ReportLineName line={line} drill={drill} />
                </div>
              </div>
              <dl className="mt-3 grid gap-3 border-t border-[#F0EEE9] pt-3">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-xs text-[#77756F]">مبلغ</dt>
                  <dd className="tabular-nums font-bold text-[#252522]">
                    {formatToman(line.amount)}
                  </dd>
                </div>
                {showPrevious ? (
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-xs text-[#77756F]">دورهٔ قبل</dt>
                    <dd className="tabular-nums text-[#5E5B55]">
                      {previousValue !== null
                        ? formatToman(previousValue)
                        : "—"}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </article>
          );
        })}
        {lines.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[#DEDAD2] bg-[#FCFBF8] px-4 py-8 text-center text-sm text-[#77756F]">
            بدون سطر
          </p>
        ) : null}
        <dl className="rounded-xl border border-[#DEDAD2] bg-[#FCFBF8] p-4">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-sm font-bold text-[#252522]">{totalLabel}</dt>
            <dd className="tabular-nums font-bold text-[#252522]">
              {formatToman(total)}
            </dd>
          </div>
          {showPrevious ? (
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-[#E8E4DD] pt-2">
              <dt className="text-xs text-[#77756F]">دورهٔ قبل</dt>
              <dd className="tabular-nums text-[#77756F]">
                {previousTotal != null ? formatToman(previousTotal) : "—"}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
    </section>
  );
}

function SummaryStat({
  label,
  value,
  previous,
}: {
  label: string;
  value: number;
  previous?: number | null;
}) {
  return (
    <div className="rounded-xl border border-[#EEECE7] bg-[#FFFEFC] p-4">
      <dt className="text-sm text-[#77756F]">{label}</dt>
      <dd
        className={
          value < 0
            ? "mt-2 font-bold tabular-nums text-destructive"
            : "mt-2 font-bold tabular-nums text-[#252522]"
        }
      >
        {formatToman(value)}
      </dd>
      {previous != null ? (
        <p className="mt-1 text-xs text-[#77756F]">
          دورهٔ قبل: {formatToman(previous)}
        </p>
      ) : null}
    </div>
  );
}

/** Owns the drill-down panel's open/close state, so every statement view opens the same overlay the same way. */
function useDrillDown(
  dateFrom?: string,
  dateTo?: string,
): { drill: DrillContext; panel: ReactNode } {
  const [target, setTarget] = useState<DrillDownTarget | null>(null);
  const drill: DrillContext = {
    dateFrom,
    dateTo,
    onDrillDown: (accountCode, accountName) =>
      setTarget({ accountCode, accountName, dateFrom, dateTo }),
  };
  const panel = target ? (
    <DrillDownPanel target={target} onClose={() => setTarget(null)} />
  ) : null;
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

      <dl className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3">
        <SummaryStat
          label="بهای تمام‌شده کالای فروش‌رفته (COGS)"
          value={current.costOfSales}
          previous={previous?.costOfSales}
        />
        <SummaryStat
          label="سود ناخالص"
          value={current.grossProfit}
          previous={previous?.grossProfit}
        />
        <SummaryStat
          label="هزینه نیروی انسانی"
          value={current.laborCost}
          previous={previous?.laborCost}
        />
        <SummaryStat
          label="بهای اولیه (Prime Cost)"
          value={current.primeCost}
          previous={previous?.primeCost}
        />
        <SummaryStat
          label="سایر هزینه‌های عملیاتی"
          value={current.operatingExpenses}
          previous={previous?.operatingExpenses}
        />
      </dl>

      <dl className="mt-5 rounded-xl border border-[#DEDAD2] bg-[#FCFBF8] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <dt className="font-bold text-[#252522]">سود (زیان) خالص</dt>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {previous ? (
              <span className="text-sm text-[#77756F]">
                دورهٔ قبل: {formatToman(previous.netIncome)}
              </span>
            ) : null}
            <dd
              className={
                current.netIncome < 0
                  ? "text-lg font-bold tabular-nums text-destructive"
                  : "text-lg font-bold tabular-nums text-[#252522]"
              }
            >
              {formatToman(current.netIncome)}
            </dd>
          </div>
        </div>
      </dl>
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

  const equityLines = [
    ...current.equity,
    {
      accountCode: "",
      accountName: "سود انباشته (جاری)",
      amount: current.retainedEarnings,
    },
  ];
  const previousEquityLines = previous
    ? [
        ...previous.equity,
        {
          accountCode: "",
          accountName: "سود انباشته (جاری)",
          amount: previous.retainedEarnings,
        },
      ]
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

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#DEDAD2] bg-[#FCFBF8] p-4">
        <span className="font-bold text-[#252522]">وضعیت تراز</span>
        <span
          className={
            current.balanced
              ? "inline-flex items-center gap-2 rounded-full bg-[#E7F6EC] px-3 py-1.5 text-sm font-bold text-[#1E7A45]"
              : "inline-flex items-center gap-2 rounded-full bg-[#FDECEC] px-3 py-1.5 text-sm font-bold text-destructive"
          }
        >
          <span
            aria-hidden="true"
            className={
              current.balanced
                ? "size-2 rounded-full bg-[#36B56A]"
                : "size-2 rounded-full bg-[#D95757]"
            }
          />
          {current.balanced ? "متوازن" : "نامتوازن"}
        </span>
      </div>
      {panel}
    </div>
  );
}

export function CashFlowView({
  report,
}: {
  report: CashFlow | Comparison<CashFlow>;
}) {
  const current = isComparison(report) ? report.current : report;
  const previous = isComparison(report) ? report.previous : null;

  return (
    <div>
      <section>
        <h3 className="mb-3 text-base font-bold text-[#252522]">
          گردش وجوه نقد بر اساس نوع رویداد
        </h3>

        <div className="hidden overflow-hidden rounded-xl border border-[#EEECE7] sm:block">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">
                گردش وجوه نقد بر اساس نوع رویداد
              </caption>
              <thead className="bg-[#FCFBF8] text-[#77756F]">
                <tr className="border-b border-[#EEECE7]">
                  <th
                    scope="col"
                    className="px-4 py-3 text-start text-xs font-semibold"
                  >
                    نوع رویداد
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-end text-xs font-semibold"
                  >
                    مبلغ
                  </th>
                  {previous ? (
                    <th
                      scope="col"
                      className="px-4 py-3 text-end text-xs font-semibold"
                    >
                      دورهٔ قبل
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {current.lines.map((line) => {
                  const previousValue =
                    previous?.lines.find(
                      (item) => item.sourceType === line.sourceType,
                    )?.amount ?? null;
                  return (
                    <tr
                      key={line.sourceType}
                      className="border-b border-[#F0EEE9] last:border-b-0"
                    >
                      <td className="px-4 py-3.5 font-semibold text-[#252522]">
                        {line.label}
                      </td>
                      <td className="px-4 py-3.5 text-end tabular-nums font-medium text-[#252522]">
                        {formatToman(line.amount)}
                      </td>
                      {previous ? (
                        <td className="px-4 py-3.5 text-end tabular-nums text-[#77756F]">
                          {previousValue !== null
                            ? formatToman(previousValue)
                            : "—"}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
                {current.lines.length === 0 ? (
                  <tr>
                    <td
                      colSpan={previous ? 3 : 2}
                      className="px-4 py-8 text-center text-sm text-[#77756F]"
                    >
                      بدون رویداد نقدی
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-2 sm:hidden">
          {current.lines.map((line) => {
            const previousValue =
              previous?.lines.find(
                (item) => item.sourceType === line.sourceType,
              )?.amount ?? null;
            return (
              <article
                key={line.sourceType}
                className="rounded-xl border border-[#EEECE7] bg-[#FFFEFC] p-4"
              >
                <h4 className="font-semibold text-[#252522]">{line.label}</h4>
                <dl className="mt-3 space-y-2 border-t border-[#F0EEE9] pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-xs text-[#77756F]">مبلغ</dt>
                    <dd className="tabular-nums font-bold text-[#252522]">
                      {formatToman(line.amount)}
                    </dd>
                  </div>
                  {previous ? (
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-xs text-[#77756F]">دورهٔ قبل</dt>
                      <dd className="tabular-nums text-[#5E5B55]">
                        {previousValue !== null
                          ? formatToman(previousValue)
                          : "—"}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </article>
            );
          })}
          {current.lines.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[#DEDAD2] bg-[#FCFBF8] px-4 py-8 text-center text-sm text-[#77756F]">
              بدون رویداد نقدی
            </p>
          ) : null}
        </div>
      </section>

      <dl className="mt-5 space-y-3 rounded-xl border border-[#DEDAD2] bg-[#FCFBF8] p-4">
        <div className="flex items-center justify-between gap-3 text-sm">
          <dt className="text-[#77756F]">موجودی ابتدای دوره</dt>
          <dd className="tabular-nums font-semibold text-[#252522]">
            {formatToman(current.openingCash)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <dt className="text-[#77756F]">موجودی پایان دوره</dt>
          <dd className="tabular-nums font-semibold text-[#252522]">
            {formatToman(current.closingCash)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-[#DEDAD2] pt-3">
          <dt className="font-bold text-[#252522]">تغییر خالص وجه نقد</dt>
          <dd
            className={
              current.netChange < 0
                ? "font-bold tabular-nums text-destructive"
                : "font-bold tabular-nums text-[#252522]"
            }
          >
            {formatToman(current.netChange)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
