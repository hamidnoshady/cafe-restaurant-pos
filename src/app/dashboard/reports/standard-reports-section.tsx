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
    fetch("/api/reports/standard").then((r) => r.json()).then((d) => setReports(d.reports ?? []));
    fetch("/api/reports/views").then((r) => r.json()).then((d) => setViews(d.views ?? []));
    fetch("/api/reports/saved").then((r) => r.json()).then((d) => {
      const map = new Map<string, string>();
      for (const r of (d.reports ?? []) as SavedReportRow[]) {
        if (r.standard_key) map.set(r.standard_key, r.id);
      }
      setSavedIds(map);
    });
  }, []);

  const hasDateColumn = selected?.config ? views.find((v) => v.key === selected.config!.view)?.hasDateColumn : false;

  const load = useCallback(async () => {
    if (!selected) return;
    if (LEDGER_KEYS.has(selected.key)) {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (compare) params.set("compare", "1");
      const res = await fetch(`/api/reports/standard/${selected.key}?${params}`);
      const data = await res.json();
      setLedgerReport(data.report ?? data.comparison ?? null);
      setRows(null);
      return;
    }
    const config = { ...selected.config, filters: { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined } };
    const res = await fetch("/api/reports/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const data = await res.json();
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

  if (!reports) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <nav className="space-y-1">
        {reports.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => select(r)}
            className={`block w-full rounded-lg px-3 py-2 text-start text-sm ${
              selected?.key === r.key ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {r.label}
          </button>
        ))}
      </nav>

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        {!selected ? (
          <p className="text-sm text-muted-foreground">یک گزارش را از فهرست انتخاب کنید.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-semibold">{selected.label}</h2>
              <div className="flex flex-wrap items-center gap-2">
                {(hasDateColumn || LEDGER_KEYS.has(selected.key)) && (
                  <>
                    <div className="w-36">
                      <JalaliDatePicker value={dateFrom} onChange={setDateFrom} placeholder="از تاریخ" />
                    </div>
                    <span className="text-xs text-muted-foreground">تا</span>
                    <div className="w-36">
                      <JalaliDatePicker value={dateTo} onChange={setDateTo} placeholder="تا تاریخ" />
                    </div>
                  </>
                )}
                {LEDGER_KEYS.has(selected.key) ? (
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
                    مقایسه با دورهٔ قبل
                  </label>
                ) : null}
                {selected.chartType ? (
                  <select className={inputClass} value={chartType} onChange={(e) => setChartType(e.target.value as ChartType)}>
                    <option value="bar">میله‌ای</option>
                    <option value="line">خطی</option>
                    <option value="pie">دایره‌ای</option>
                    <option value="number">عدد</option>
                  </select>
                ) : null}
              </div>
            </div>

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
                <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
              )
            ) : rows === null ? (
              <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
            ) : (
              <>
                <ChartPreview chartType={chartType} data={rowsToChartData(rows)} label={selected.label} />
                <DataTable columns={["بُعد", "مقدار"]} data={rowsToChartData(rows)} />
              </>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
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
                    : { title: selected.label, kind: "chart", config: { ...selected.config, filters: { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined } } }
                }
              />
              {selected.chartType && savedIds.has(selected.key) ? (
                <PinToDashboardButton savedReportId={savedIds.get(selected.key)!} chartType={chartType} title={selected.label} />
              ) : null}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
