"use client";

import { useCallback, useEffect, useState } from "react";
import { JalaliDatePicker } from "../jalali-date-picker";
import { inputClass } from "../ui";
import { ChartPreview, DataTable } from "./chart-preview";
import { ExportButtons } from "./export-buttons";
import { PinToDashboardButton } from "./pin-button";
import {
  BalanceSheetView,
  CashFlowView,
  ProfitAndLossView,
  type BalanceSheet,
  type CashFlow,
  type Comparison,
  type ProfitAndLoss,
} from "./ledger-report-view";
import { rowsToChartData, type ChartType, type ReportRow } from "./report-ui";

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

const LEDGER_KEYS = new Set(["profit_and_loss", "balance_sheet", "cash_flow"]);
const CONTROL_CLASS = [inputClass, "min-h-12 border-[#DEDAD2] bg-white text-[#252522]"].join(" ");

type LedgerReportData =
  | ProfitAndLoss
  | BalanceSheet
  | CashFlow
  | Comparison<ProfitAndLoss>
  | Comparison<BalanceSheet>
  | Comparison<CashFlow>;

export function StandardReportsSection() {
  const [reports, setReports] = useState<StandardReportDef[] | null>(null);
  const [views, setViews] = useState<ViewMeta[]>([]);
  const [savedIds, setSavedIds] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<StandardReportDef | null>(null);
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [compare, setCompare] = useState(false);
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [ledgerReport, setLedgerReport] = useState<LedgerReportData | null>(null);

  useEffect(() => {
    fetch("/api/reports/standard").then((response) => response.json()).then((data) => setReports(data.reports ?? []));
    fetch("/api/reports/views").then((response) => response.json()).then((data) => setViews(data.views ?? []));
    fetch("/api/reports/saved").then((response) => response.json()).then((data) => {
      const map = new Map<string, string>();
      for (const report of (data.reports ?? []) as SavedReportRow[]) {
        if (report.standard_key) map.set(report.standard_key, report.id);
      }
      setSavedIds(map);
    });
  }, []);

  const hasDateColumn = selected?.config ? views.find((view) => view.key === selected.config!.view)?.hasDateColumn : false;

  const load = useCallback(async () => {
    if (!selected) return;
    if (LEDGER_KEYS.has(selected.key)) {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (compare) params.set("compare", "1");
      const response = await fetch("/api/reports/standard/" + selected.key + "?" + params);
      const data = await response.json();
      setLedgerReport(data.report ?? data.comparison ?? null);
      setRows(null);
      return;
    }
    const config = { ...selected.config, filters: { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined } };
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

  if (!reports) {
    return (
      <section
        role="status"
        aria-live="polite"
        aria-label="در حال بارگذاری گزارش‌های آماده"
        className="rounded-2xl border border-[#EAE8E2] bg-white px-5 py-8 text-sm text-[#77756F] shadow-[0_1px_2px_rgb(41_37_36/0.03)]"
      >
        در حال بارگذاری…
      </section>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(12.5rem,15rem)_minmax(0,1fr)] md:items-start lg:gap-5">
      <aside
        aria-labelledby="prepared-reports-heading"
        className="min-w-0 rounded-2xl border border-[#EAE8E2] bg-white p-3 shadow-[0_1px_2px_rgb(41_37_36/0.03)] md:sticky md:top-5"
      >
        <div className="border-b border-[#F0EEE9] px-2 pb-3">
          <p className="text-xs font-semibold text-[#9B6700]">کتابخانهٔ گزارش</p>
          <h2 id="prepared-reports-heading" className="mt-1 font-bold text-[#252522]">گزارش‌های آماده</h2>
        </div>

        <nav aria-label="فهرست گزارش‌های آماده" className="mt-3 overflow-x-auto pb-1 md:max-h-[calc(100vh-15rem)] md:overflow-y-auto">
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
                    "min-h-12 shrink-0 rounded-xl border px-3 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 md:w-full",
                    isSelected
                      ? "border-[#F0D7A8] bg-[#FFF1D8] font-bold text-[#8A5C00]"
                      : "border-transparent text-[#5E5B55] hover:border-[#EAE8E2] hover:bg-[#FCFBF8] hover:text-[#252522]",
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
        className="min-w-0 rounded-2xl border border-[#EAE8E2] bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.03)] sm:p-5"
      >
        {!selected ? (
          <div className="flex min-h-48 items-center rounded-xl border border-dashed border-[#DEDAD2] bg-[#FCFBF8] px-5 text-sm text-[#77756F]">
            یک گزارش را از فهرست انتخاب کنید.
          </div>
        ) : (
          <div className="space-y-5">
            <header className="border-b border-[#F0EEE9] pb-5">
              <p className="text-xs font-semibold text-[#9B6700]">پیش‌نمایش گزارش</p>
              <h2 id="prepared-report-preview-heading" className="mt-1 text-lg font-bold text-[#252522]">
                {selected.label}
              </h2>

              {(hasDateColumn || LEDGER_KEYS.has(selected.key) || selected.chartType) ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {hasDateColumn || LEDGER_KEYS.has(selected.key) ? (
                    <>
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-[#77756F]">از تاریخ</span>
                        <JalaliDatePicker
                          value={dateFrom}
                          onChange={setDateFrom}
                          placeholder="از تاریخ"
                          className={CONTROL_CLASS}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-[#77756F]">تا تاریخ</span>
                        <JalaliDatePicker
                          value={dateTo}
                          onChange={setDateTo}
                          placeholder="تا تاریخ"
                          className={CONTROL_CLASS}
                        />
                      </label>
                    </>
                  ) : null}

                  {selected.chartType ? (
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-[#77756F]">نوع نمایش</span>
                      <select
                        className={CONTROL_CLASS}
                        value={chartType}
                        onChange={(event) => setChartType(event.target.value as ChartType)}
                      >
                        <option value="bar">میله‌ای</option>
                        <option value="line">خطی</option>
                        <option value="pie">دایره‌ای</option>
                        <option value="number">عدد</option>
                      </select>
                    </label>
                  ) : null}
                </div>
              ) : null}

              {LEDGER_KEYS.has(selected.key) ? (
                <label className="mt-3 flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-[#EEECE7] bg-[#FCFBF8] px-3 text-sm text-[#5E5B55] sm:w-fit">
                  <input
                    type="checkbox"
                    checked={compare}
                    onChange={(event) => setCompare(event.target.checked)}
                    className="size-5 rounded border-[#B7B4AD] text-[#C98712] focus-visible:ring-[#E9A11B]/45"
                  />
                  مقایسه با دورهٔ قبل
                </label>
              ) : null}
            </header>

            {LEDGER_KEYS.has(selected.key) ? (
              ledgerReport ? (
                selected.key === "profit_and_loss" ? (
                  <ProfitAndLossView
                    report={ledgerReport as ProfitAndLoss | Comparison<ProfitAndLoss>}
                    dateFrom={dateFrom || undefined}
                    dateTo={dateTo || undefined}
                  />
                ) : selected.key === "balance_sheet" ? (
                  <BalanceSheetView
                    report={ledgerReport as BalanceSheet | Comparison<BalanceSheet>}
                    dateTo={dateTo || undefined}
                  />
                ) : (
                  <CashFlowView report={ledgerReport as CashFlow | Comparison<CashFlow>} />
                )
              ) : (
                <p role="status" className="rounded-xl bg-[#FCFBF8] px-4 py-8 text-center text-sm text-[#77756F]">
                  در حال بارگذاری…
                </p>
              )
            ) : rows === null ? (
              <p role="status" className="rounded-xl bg-[#FCFBF8] px-4 py-8 text-center text-sm text-[#77756F]">
                در حال بارگذاری…
              </p>
            ) : (
              <div className="space-y-5">
                <ChartPreview chartType={chartType} data={rowsToChartData(rows)} label={selected.label} />
                <DataTable columns={["بُعد", "مقدار"]} data={rowsToChartData(rows)} />
              </div>
            )}

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#F0EEE9] pt-4">
              <ExportButtons
                request={
                  LEDGER_KEYS.has(selected.key)
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
                        config: { ...selected.config, filters: { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined } },
                      }
                }
              />
              {selected.chartType && savedIds.has(selected.key) ? (
                <PinToDashboardButton savedReportId={savedIds.get(selected.key)!} chartType={chartType} title={selected.label} />
              ) : null}
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}
