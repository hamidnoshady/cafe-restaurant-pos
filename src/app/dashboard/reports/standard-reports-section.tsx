"use client";

import { SectionCardSkeleton, LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useState } from "react";
import { SparklesIcon } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "../jalali-date-picker";
import { BusinessDayRangePresets } from "./business-day-range";
import { inputClass } from "../ui";
import { ChartPreview, DataTable } from "./chart-preview";
import { ExportButtons } from "./export-buttons";
import { PinToDashboardButton } from "./pin-button";
import {
  BalanceSheetView,
  CashFlowView,
  FoodCostVarianceView,
  ProfitAndLossView,
  type BalanceSheet,
  type CashFlow,
  type Comparison,
  type FoodCostVariance,
  type ProfitAndLoss,
} from "./ledger-report-view";
import { rowsToChartData, type ChartType, type ReportRow } from "./report-ui";
import { cardClass } from "../page-chrome";

interface StandardReportDef {
  key: string;
  label: string;
  chartType: ChartType | null;
  config: Record<string, unknown> | null;
}

interface ViewMeta {
  key: string;
  hasDateColumn: boolean;
}

interface SavedReportRow {
  id: string;
  standard_key: string | null;
}

const LEDGER_KEYS = new Set(["profit_and_loss", "balance_sheet", "cash_flow", "food_cost_variance"]);
// Period comparison (`?compare=1`) isn't implemented for food_cost_variance —
// it's a period total against the ledger, not a per-account rollup, and the
// "worst item" ranking doesn't have an obvious side-by-side presentation yet.
const COMPARABLE_LEDGER_KEYS = new Set(["profit_and_loss", "balance_sheet", "cash_flow"]);
const CONTROL_CLASS = [
  inputClass,
  "min-h-[52px] border-border/80 bg-card text-foreground",
].join(" ");

type LedgerReportData =
  | ProfitAndLoss
  | BalanceSheet
  | CashFlow
  | FoodCostVariance
  | Comparison<ProfitAndLoss>
  | Comparison<BalanceSheet>
  | Comparison<CashFlow>;

export function StandardReportsSection({ canExplain }: { canExplain: boolean }) {
  const [reports, setReports] = useState<StandardReportDef[] | null>(null);
  const [views, setViews] = useState<ViewMeta[]>([]);
  const [savedIds, setSavedIds] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<StandardReportDef | null>(null);
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [compare, setCompare] = useState(false);
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [ledgerReport, setLedgerReport] = useState<LedgerReportData | null>(
    null,
  );

  useEffect(() => {
    fetch("/api/reports/standard")
      .then((response) => response.json())
      .then((data) => setReports(data.reports ?? []));
    fetch("/api/reports/views")
      .then((response) => response.json())
      .then((data) => setViews(data.views ?? []));
    fetch("/api/reports/saved")
      .then((response) => response.json())
      .then((data) => {
        const map = new Map<string, string>();
        for (const report of (data.reports ?? []) as SavedReportRow[]) {
          if (report.standard_key) map.set(report.standard_key, report.id);
        }
        setSavedIds(map);
      });
  }, []);

  const hasDateColumn = selected?.config
    ? views.find((view) => view.key === selected.config!.view)?.hasDateColumn
    : false;

  const load = useCallback(async () => {
    if (!selected) return;
    if (LEDGER_KEYS.has(selected.key)) {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (compare && COMPARABLE_LEDGER_KEYS.has(selected.key)) params.set("compare", "1");
      const response = await fetch(
        "/api/reports/standard/" + selected.key + "?" + params,
      );
      const data = await response.json();
      setLedgerReport(data.report ?? data.comparison ?? null);
      setRows(null);
      return;
    }
    const config = {
      ...selected.config,
      filters: { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined },
    };
    const response = await fetch("/api/reports/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const data = await response.json();
    setRows(data.rows ?? []);
    setLedgerReport(null);
  }, [selected, dateFrom, dateTo, compare]);

  useEffect(() => {
    load();
  }, [load]);

  function select(report: StandardReportDef) {
    setSelected(report);
    setChartType(report.chartType ?? "bar");
    setDateFrom("");
    setDateTo("");
    setCompare(false);
    setRows(null);
    setLedgerReport(null);
  }

  function explainSelectedReport() {
    if (!selected) return;
    const facts = rows
      ? rowsToChartData(rows)
          .slice(0, 8)
          .map((row) => `${row.label}: ${row.value.toLocaleString("fa-IR")}`)
          .join("؛ ")
      : "";
    const period =
      dateFrom || dateTo
        ? `بازهٔ انتخاب‌شده: ${dateFrom || "ابتدای داده"} تا ${dateTo || "امروز"}.`
        : "";
    const prompt = [
      `گزارش «${selected.label}» را با اتکا به داده‌های واقعی بررسی و توضیح بده.`,
      period,
      facts ? `دادهٔ نمایشی فعلی: ${facts}.` : "",
      "اگر دادهٔ کافی برای نتیجه‌گیری وجود ندارد، صریح بگو چه گزارشی باید بررسی شود؛ عددی را حدس نزن.",
    ]
      .filter(Boolean)
      .join("\n");
    window.dispatchEvent(new CustomEvent("ai:prefill", { detail: { prompt } }));
  }

  if (!reports) {
    return (
      <SectionCardSkeleton rows={4} label="در حال بارگذاری گزارش‌های آماده" />
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(12.5rem,15rem)_minmax(0,1fr)] md:items-start lg:gap-5">
      <aside
        aria-labelledby="prepared-reports-heading"
        className={`min-w-0 ${cardClass} p-3 shadow-[0_1px_2px_rgb(41_37_36/0.03)] md:sticky md:top-5`}
      >
        <div className="border-b border-border px-2 pb-3">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
            کتابخانهٔ گزارش
          </p>
          <h2
            id="prepared-reports-heading"
            className="mt-1 font-bold text-foreground"
          >
            گزارش‌های آماده
          </h2>
        </div>

        <nav
          aria-label="فهرست گزارش‌های آماده"
          className="mt-3 overflow-x-auto pb-1 md:max-h-[calc(100vh-15rem)] md:overflow-y-auto"
        >
          <div className="flex min-w-max gap-2 md:min-w-0 md:flex-col md:gap-1">
            {reports.map((report) => {
              const isSelected = selected?.key === report.key;
              return (
                <button
                  key={report.key}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => select(report)}
                  className={[
                    "min-h-[52px] shrink-0 rounded-xl border px-3 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 md:w-full",
                    isSelected
                      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-bold text-amber-800 dark:text-amber-300"
                      : "border-transparent text-muted-foreground hover:border-border/80 hover:bg-muted hover:text-foreground",
                  ].join(" ")}
                >
                  {report.label}
                </button>
              );
            })}
          </div>
        </nav>
      </aside>

      <section
        aria-live="polite"
        aria-labelledby="prepared-report-preview-heading"
        className={`min-w-0 ${cardClass} p-4 shadow-[0_1px_2px_rgb(41_37_36/0.03)] sm:p-5`}
      >
        {!selected ? (
          <div className="flex min-h-48 items-center rounded-xl border border-dashed border-border/80 bg-muted px-5 text-sm text-muted-foreground">
            یک گزارش را از فهرست انتخاب کنید.
          </div>
        ) : (
          <div className="space-y-5">
            <header className="border-b border-border pb-5">
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                پیش‌نمایش گزارش
              </p>
              <h2
                id="prepared-report-preview-heading"
                className="mt-1 text-lg font-bold text-foreground"
              >
                {selected.label}
              </h2>

              {hasDateColumn ||
              LEDGER_KEYS.has(selected.key) ||
              selected.chartType ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {hasDateColumn || LEDGER_KEYS.has(selected.key) ? (
                    <>
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                          از تاریخ
                        </span>
                        <JalaliDatePicker
                          value={dateFrom}
                          onChange={setDateFrom}
                          placeholder="از تاریخ"
                          className={CONTROL_CLASS}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                          تا تاریخ
                        </span>
                        <JalaliDatePicker
                          value={dateTo}
                          onChange={setDateTo}
                          placeholder="تا تاریخ"
                          className={CONTROL_CLASS}
                        />
                      </label>
                    </>
                  ) : null}

                  {hasDateColumn || LEDGER_KEYS.has(selected.key) ? (
                    <div className="sm:col-span-2 xl:col-span-3">
                      <BusinessDayRangePresets
                        onSelect={(range) => {
                          setDateFrom(range.dateFrom);
                          setDateTo(range.dateTo);
                        }}
                        onClear={() => {
                          setDateFrom("");
                          setDateTo("");
                        }}
                      />
                    </div>
                  ) : null}

                  {selected.chartType ? (
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                        نوع نمایش
                      </span>
                      <SearchableSelect
                        className={CONTROL_CLASS}
                        value={chartType}
                        onChange={(value) => setChartType(value as ChartType)}
                        options={[
                          { value: "bar", label: "میله‌ای" },
                          { value: "line", label: "خطی" },
                          { value: "pie", label: "دایره‌ای" },
                          { value: "number", label: "عدد" },
                        ]}
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}

              {COMPARABLE_LEDGER_KEYS.has(selected.key) ? (
                <label className="mt-3 flex min-h-[52px] cursor-pointer items-center gap-3 rounded-xl border border-border/80 bg-muted px-3 text-sm text-muted-foreground sm:w-fit">
                  <input
                    type="checkbox"
                    checked={compare}
                    onChange={(event) => setCompare(event.target.checked)}
                    className="size-5 rounded border-input text-amber-600 dark:text-amber-400 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
                  />
                  مقایسه با دورهٔ قبل
                </label>
              ) : null}
            </header>

            {LEDGER_KEYS.has(selected.key) ? (
              ledgerReport ? (
                selected.key === "profit_and_loss" ? (
                  <ProfitAndLossView
                    report={
                      ledgerReport as ProfitAndLoss | Comparison<ProfitAndLoss>
                    }
                    dateFrom={dateFrom || undefined}
                    dateTo={dateTo || undefined}
                  />
                ) : selected.key === "balance_sheet" ? (
                  <BalanceSheetView
                    report={
                      ledgerReport as BalanceSheet | Comparison<BalanceSheet>
                    }
                    dateTo={dateTo || undefined}
                  />
                ) : selected.key === "cash_flow" ? (
                  <CashFlowView
                    report={ledgerReport as CashFlow | Comparison<CashFlow>}
                  />
                ) : (
                  <FoodCostVarianceView
                    report={ledgerReport as FoodCostVariance}
                  />
                )
              ) : (
                <LoadingSkeleton rows={4} />
              )
            ) : rows === null ? (
              <LoadingSkeleton rows={4} />
            ) : (
              <div className="space-y-5">
                <ChartPreview
                  chartType={chartType}
                  data={rowsToChartData(rows)}
                  label={selected.label}
                />
                <DataTable
                  columns={["بُعد", "مقدار"]}
                  data={rowsToChartData(rows)}
                />
              </div>
            )}

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              {/* food_cost_variance has no export kind yet (see ExportRequest["kind"]) — a v1 scoping decision, not an oversight. */}
              {selected.key !== "food_cost_variance" ? (
                <ExportButtons
                  request={
                    COMPARABLE_LEDGER_KEYS.has(selected.key)
                      ? {
                          title: selected.label,
                          kind:
                            selected.key === "profit_and_loss"
                              ? "pnl"
                              : selected.key === "balance_sheet"
                                ? "balance_sheet"
                                : "cash_flow",
                          dateFrom,
                          dateTo,
                        }
                      : {
                          title: selected.label,
                          kind: "chart",
                          config: {
                            ...selected.config,
                            filters: {
                              dateFrom: dateFrom || undefined,
                              dateTo: dateTo || undefined,
                            },
                          },
                        }
                  }
                />
              ) : null}
              {canExplain && (rows !== null || ledgerReport !== null) ? (
                <button
                  type="button"
                  onClick={explainSelectedReport}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-3 text-sm font-semibold text-amber-800 dark:text-amber-300 transition-colors hover:bg-amber-100 dark:hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
                >
                  <SparklesIcon className="size-4" /> توضیح این عدد
                </button>
              ) : null}
              {selected.chartType && savedIds.has(selected.key) ? (
                <PinToDashboardButton
                  savedReportId={savedIds.get(selected.key)!}
                  chartType={chartType}
                  title={selected.label}
                />
              ) : null}
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}
