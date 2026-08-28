"use client";

import { useState, type ReactNode } from "react";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber } from "@/lib/digits";
import { isNonCurrentCode } from "@/lib/coa-template";
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
  currentAssets: number;
  nonCurrentAssets: number;
  currentLiabilities: number;
  nonCurrentLiabilities: number;
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

export interface FoodCostVarianceItemLine {
  menuItemId: string | null;
  menuItemName: string;
  unitsSold: number;
  theoreticalCost: number;
  revenue: number;
  foodCostPct: number | null;
}

export interface FoodCostVariance {
  items: FoodCostVarianceItemLine[];
  theoreticalCost: number;
  actualCogs: number;
  wasteCost: number;
  actualTotalCost: number;
  variance: number;
  variancePct: number | null;
  unexplainedVariance: number;
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
      <span className="font-semibold text-stone-950">{line.accountName}</span>
    );

  return (
    <button
      type="button"
      onClick={() => drill!.onDrillDown(line.accountCode, line.accountName)}
      className="min-h-10 rounded-lg px-1 text-start font-semibold text-stone-950 underline-offset-4 hover:text-amber-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45"
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
  const money = useMoney();
  const showPrevious = previousLines !== undefined;

  return (
    <section className="border-b border-stone-100 py-5 first:pt-0 last:border-b-0">
      <h3 className="mb-3 text-base font-bold text-stone-950">{heading}</h3>

      <div className="hidden overflow-hidden rounded-xl border border-stone-200/80 sm:block">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">{heading}</caption>
            <thead className="bg-stone-50 text-stone-500">
              <tr className="border-b border-stone-200/80">
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
                    className="border-b border-stone-100 last:border-b-0"
                  >
                    <td className="px-4 py-3.5 text-stone-500">
                      {line.accountCode || "—"}
                    </td>
                    <td className="px-4 py-3.5">
                      <ReportLineName line={line} drill={drill} />
                    </td>
                    <td className="px-4 py-3.5 text-end tabular-nums font-medium text-stone-950">
                      {money.format(line.amount)}
                    </td>
                    {showPrevious ? (
                      <td className="px-4 py-3.5 text-end tabular-nums text-stone-500">
                        {previousValue !== null
                          ? money.format(previousValue)
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
                    className="px-4 py-8 text-center text-sm text-stone-500"
                  >
                    بدون سطر
                  </td>
                </tr>
              ) : null}
            </tbody>
            <tfoot className="bg-stone-50">
              <tr className="border-t-2 border-stone-200/80 font-bold text-stone-950">
                <th scope="row" className="px-4 py-3.5 text-start" colSpan={2}>
                  {totalLabel}
                </th>
                <td className="px-4 py-3.5 text-end tabular-nums">
                  {money.format(total)}
                </td>
                {showPrevious ? (
                  <td className="px-4 py-3.5 text-end tabular-nums text-stone-500">
                    {previousTotal != null ? money.format(previousTotal) : "—"}
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
              className="rounded-xl border border-stone-200/80 bg-stone-50 p-4"
            >
              <div className="flex items-start gap-3">
                <span className="mt-1 shrink-0 text-xs font-medium text-stone-500">
                  {line.accountCode || "—"}
                </span>
                <div className="min-w-0 flex-1">
                  <ReportLineName line={line} drill={drill} />
                </div>
              </div>
              <dl className="mt-3 grid gap-3 border-t border-stone-100 pt-3">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-xs text-stone-500">مبلغ</dt>
                  <dd className="tabular-nums font-bold text-stone-950">
                    {money.format(line.amount)}
                  </dd>
                </div>
                {showPrevious ? (
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-xs text-stone-500">دورهٔ قبل</dt>
                    <dd className="tabular-nums text-stone-600">
                      {previousValue !== null
                        ? money.format(previousValue)
                        : "—"}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </article>
          );
        })}
        {lines.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-8 text-center text-sm text-stone-500">
            بدون سطر
          </p>
        ) : null}
        <dl className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-sm font-bold text-stone-950">{totalLabel}</dt>
            <dd className="tabular-nums font-bold text-stone-950">
              {money.format(total)}
            </dd>
          </div>
          {showPrevious ? (
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-stone-200/80 pt-2">
              <dt className="text-xs text-stone-500">دورهٔ قبل</dt>
              <dd className="tabular-nums text-stone-500">
                {previousTotal != null ? money.format(previousTotal) : "—"}
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
  const money = useMoney();
  return (
    <div className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
      <dt className="text-sm text-stone-500">{label}</dt>
      <dd
        className={
          value < 0
            ? "mt-2 font-bold tabular-nums text-destructive"
            : "mt-2 font-bold tabular-nums text-stone-950"
        }
      >
        {money.format(value)}
      </dd>
      {previous != null ? (
        <p className="mt-1 text-xs text-stone-500">
          دورهٔ قبل: {money.format(previous)}
        </p>
      ) : null}
    </div>
  );
}

function formatPct(value: number | null): string {
  if (value === null) return "—";
  const digits = (value * 100).toFixed(1);
  return `${digits.replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)])}٪`;
}

/**
 * Per-item theoretical (recipe-standard) food cost vs. its revenue, plus a
 * period-level theoretical-vs-actual total (see buildFoodCostVariance's doc
 * comment in reports.ts for what each figure means and why there's no
 * per-item *actual* cost). No previous-period comparison or drill-down —
 * see the "compare" checkbox gating in standard-reports-section.tsx.
 */
export function FoodCostVarianceView({ report }: { report: FoodCostVariance }) {
  const money = useMoney();
  return (
    <div>
      <section className="border-b border-stone-100 pb-5">
        <h3 className="mb-3 text-base font-bold text-stone-950">
          بهای تمام‌شده نظری هر قلم منو
        </h3>

        <div className="hidden overflow-hidden rounded-xl border border-stone-200/80 sm:block">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">بهای تمام‌شده نظری هر قلم منو</caption>
              <thead className="bg-stone-50 text-stone-500">
                <tr className="border-b border-stone-200/80">
                  <th scope="col" className="px-4 py-3 text-start text-xs font-semibold">قلم منو</th>
                  <th scope="col" className="px-4 py-3 text-end text-xs font-semibold">تعداد فروش</th>
                  <th scope="col" className="px-4 py-3 text-end text-xs font-semibold">درآمد</th>
                  <th scope="col" className="px-4 py-3 text-end text-xs font-semibold">بهای نظری</th>
                  <th scope="col" className="px-4 py-3 text-end text-xs font-semibold">درصد بهای غذا</th>
                </tr>
              </thead>
              <tbody>
                {report.items.map((item) => (
                  <tr key={item.menuItemId ?? item.menuItemName} className="border-b border-stone-100 last:border-b-0">
                    <td className="px-4 py-3.5 font-semibold text-stone-950">{item.menuItemName}</td>
                    <td className="px-4 py-3.5 text-end tabular-nums text-stone-600">
                      {formatPersianNumber(item.unitsSold)}
                    </td>
                    <td className="px-4 py-3.5 text-end tabular-nums text-stone-950">{money.format(item.revenue)}</td>
                    <td className="px-4 py-3.5 text-end tabular-nums text-stone-950">{money.format(item.theoreticalCost)}</td>
                    <td className="px-4 py-3.5 text-end tabular-nums font-medium text-stone-950">
                      {formatPct(item.foodCostPct)}
                    </td>
                  </tr>
                ))}
                {report.items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-stone-500">
                      در این بازه فروشی ثبت نشده
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-2 sm:hidden">
          {report.items.map((item) => (
            <article key={item.menuItemId ?? item.menuItemName} className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
              <h4 className="font-semibold text-stone-950">{item.menuItemName}</h4>
              <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-stone-100 pt-3">
                <div>
                  <dt className="text-xs text-stone-500">تعداد فروش</dt>
                  <dd className="tabular-nums text-stone-950">{formatPersianNumber(item.unitsSold)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">درآمد</dt>
                  <dd className="tabular-nums text-stone-950">{money.format(item.revenue)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">بهای نظری</dt>
                  <dd className="tabular-nums text-stone-950">{money.format(item.theoreticalCost)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">درصد بهای غذا</dt>
                  <dd className="tabular-nums font-bold text-stone-950">{formatPct(item.foodCostPct)}</dd>
                </div>
              </dl>
            </article>
          ))}
          {report.items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-8 text-center text-sm text-stone-500">
              در این بازه فروشی ثبت نشده
            </p>
          ) : null}
        </div>
      </section>

      <dl className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3">
        <SummaryStat label="بهای نظری (بر اساس دستور پخت)" value={report.theoreticalCost} />
        <SummaryStat label="بهای تمام‌شده واقعی (COGS)" value={report.actualCogs} />
        <SummaryStat label="ضایعات ثبت‌شده" value={report.wasteCost} />
        <SummaryStat label="جمع بهای واقعی (COGS + ضایعات)" value={report.actualTotalCost} />
        <SummaryStat label="مابه‌التفاوت (واریانس)" value={report.variance} />
        <SummaryStat label="مابه‌التفاوت توضیح‌نیافته (منهای ضایعات)" value={report.unexplainedVariance} />
      </dl>

      <dl className="mt-5 rounded-xl border border-stone-200/80 bg-stone-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <dt className="font-bold text-stone-950">درصد واریانس نسبت به بهای نظری</dt>
          <dd
            className={
              report.variance > 0
                ? "text-lg font-bold tabular-nums text-destructive"
                : "text-lg font-bold tabular-nums text-stone-950"
            }
          >
            {formatPct(report.variancePct)}
          </dd>
        </div>
      </dl>
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
  const money = useMoney();
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

      <dl className="mt-5 rounded-xl border border-stone-200/80 bg-stone-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <dt className="font-bold text-stone-950">سود (زیان) خالص</dt>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {previous ? (
              <span className="text-sm text-stone-500">
                دورهٔ قبل: {money.format(previous.netIncome)}
              </span>
            ) : null}
            <dd
              className={
                current.netIncome < 0
                  ? "text-lg font-bold tabular-nums text-destructive"
                  : "text-lg font-bold tabular-nums text-stone-950"
              }
            >
              {money.format(current.netIncome)}
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
  const money = useMoney();
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

  // The جاری/غیرجاری split. Non-current groups are rendered only when they have
  // lines, so a business with no fixed assets and no borrowings still reads as
  // the flat sheet it effectively is.
  const split = (lines: PnlLine[], type: "asset" | "liability", nonCurrent: boolean) =>
    lines.filter((l) => isNonCurrentCode(type, l.accountCode) === nonCurrent);

  const currentAssetLines = split(current.assets, "asset", false);
  const nonCurrentAssetLines = split(current.assets, "asset", true);
  const currentLiabilityLines = split(current.liabilities, "liability", false);
  const nonCurrentLiabilityLines = split(current.liabilities, "liability", true);

  return (
    <div>
      <Section
        heading="دارایی‌های جاری"
        lines={currentAssetLines}
        previousLines={previous ? split(previous.assets, "asset", false) : undefined}
        total={current.currentAssets}
        previousTotal={previous?.currentAssets}
        totalLabel="جمع دارایی‌های جاری"
        drill={drill}
      />
      {nonCurrentAssetLines.length > 0 ? (
        <Section
          heading="دارایی‌های غیرجاری"
          lines={nonCurrentAssetLines}
          previousLines={previous ? split(previous.assets, "asset", true) : undefined}
          total={current.nonCurrentAssets}
          previousTotal={previous?.nonCurrentAssets}
          totalLabel="جمع دارایی‌های غیرجاری"
          drill={drill}
        />
      ) : null}
      <Section
        heading="بدهی‌های جاری"
        lines={currentLiabilityLines}
        previousLines={previous ? split(previous.liabilities, "liability", false) : undefined}
        total={current.currentLiabilities}
        previousTotal={previous?.currentLiabilities}
        totalLabel="جمع بدهی‌های جاری"
        drill={drill}
      />
      {nonCurrentLiabilityLines.length > 0 ? (
        <Section
          heading="بدهی‌های غیرجاری"
          lines={nonCurrentLiabilityLines}
          previousLines={previous ? split(previous.liabilities, "liability", true) : undefined}
          total={current.nonCurrentLiabilities}
          previousTotal={previous?.nonCurrentLiabilities}
          totalLabel="جمع بدهی‌های غیرجاری"
          drill={drill}
        />
      ) : null}
      <Section
        heading="حقوق صاحبان سرمایه"
        lines={equityLines}
        previousLines={previousEquityLines}
        total={current.totalEquity}
        previousTotal={previous?.totalEquity}
        totalLabel="جمع حقوق صاحبان سرمایه"
        drill={drill}
      />

      <dl className="mt-5 grid gap-3 rounded-xl border border-stone-200/80 bg-stone-50 p-4 sm:grid-cols-3">
        {[
          ["جمع دارایی‌ها", current.totalAssets],
          ["جمع بدهی‌ها", current.totalLiabilities],
          ["جمع حقوق صاحبان سرمایه", current.totalEquity],
        ].map(([label, amount]) => (
          <div key={label as string} className="flex items-center justify-between gap-3 sm:flex-col sm:items-start sm:gap-1">
            <dt className="text-xs text-stone-500">{label}</dt>
            <dd className="tabular-nums font-bold text-stone-950">{money.format(amount as number)}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200/80 bg-stone-50 p-4">
        <span className="font-bold text-stone-950">وضعیت تراز</span>
        <span
          className={
            current.balanced
              ? "inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-bold text-emerald-700"
              : "inline-flex items-center gap-2 rounded-full bg-destructive/10 px-3 py-1.5 text-sm font-bold text-destructive"
          }
        >
          <span
            aria-hidden="true"
            className={
              current.balanced
                ? "size-2 rounded-full bg-emerald-500"
                : "size-2 rounded-full bg-destructive"
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
  const money = useMoney();
  const current = isComparison(report) ? report.current : report;
  const previous = isComparison(report) ? report.previous : null;

  return (
    <div>
      <section>
        <h3 className="mb-3 text-base font-bold text-stone-950">
          گردش وجوه نقد بر اساس نوع رویداد
        </h3>

        <div className="hidden overflow-hidden rounded-xl border border-stone-200/80 sm:block">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">
                گردش وجوه نقد بر اساس نوع رویداد
              </caption>
              <thead className="bg-stone-50 text-stone-500">
                <tr className="border-b border-stone-200/80">
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
                      className="border-b border-stone-100 last:border-b-0"
                    >
                      <td className="px-4 py-3.5 font-semibold text-stone-950">
                        {line.label}
                      </td>
                      <td className="px-4 py-3.5 text-end tabular-nums font-medium text-stone-950">
                        {money.format(line.amount)}
                      </td>
                      {previous ? (
                        <td className="px-4 py-3.5 text-end tabular-nums text-stone-500">
                          {previousValue !== null
                            ? money.format(previousValue)
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
                      className="px-4 py-8 text-center text-sm text-stone-500"
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
                className="rounded-xl border border-stone-200/80 bg-stone-50 p-4"
              >
                <h4 className="font-semibold text-stone-950">{line.label}</h4>
                <dl className="mt-3 space-y-2 border-t border-stone-100 pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-xs text-stone-500">مبلغ</dt>
                    <dd className="tabular-nums font-bold text-stone-950">
                      {money.format(line.amount)}
                    </dd>
                  </div>
                  {previous ? (
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-xs text-stone-500">دورهٔ قبل</dt>
                      <dd className="tabular-nums text-stone-600">
                        {previousValue !== null
                          ? money.format(previousValue)
                          : "—"}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </article>
            );
          })}
          {current.lines.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-8 text-center text-sm text-stone-500">
              بدون رویداد نقدی
            </p>
          ) : null}
        </div>
      </section>

      <dl className="mt-5 space-y-3 rounded-xl border border-stone-200/80 bg-stone-50 p-4">
        <div className="flex items-center justify-between gap-3 text-sm">
          <dt className="text-stone-500">موجودی ابتدای دوره</dt>
          <dd className="tabular-nums font-semibold text-stone-950">
            {money.format(current.openingCash)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <dt className="text-stone-500">موجودی پایان دوره</dt>
          <dd className="tabular-nums font-semibold text-stone-950">
            {money.format(current.closingCash)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-stone-200/80 pt-3">
          <dt className="font-bold text-stone-950">تغییر خالص وجه نقد</dt>
          <dd
            className={
              current.netChange < 0
                ? "font-bold tabular-nums text-destructive"
                : "font-bold tabular-nums text-stone-950"
            }
          >
            {money.format(current.netChange)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
