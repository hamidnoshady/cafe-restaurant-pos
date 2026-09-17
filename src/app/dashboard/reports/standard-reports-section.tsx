"use client";

/**
 * «گزارش‌های آماده» — the report library.
 *
 * Two things were wrong here before Phase 43, and they had the same root.
 *
 * The list was one flat column of every report the codebase knows, served
 * unfiltered: a jewellery shop scrolled past «چرخش میزها»، «عملکرد پیک‌ها» and
 * «گزارش ضایعات» — three reports over tables that trade never writes, so all
 * three were permanently empty — to reach a P&L, while the reports it actually
 * wanted lived on a different page entirely. The list is now grouped by
 * subject and filtered by trade on the server (`standardReportsFor`), and the
 * trades' own reports have moved in beside the shared ones.
 *
 * And the screen was hand-built: a bespoke two-pane grid, bespoke amber list
 * buttons, a bespoke `CONTROL_CLASS`, a raw `<input type="checkbox">`. Every
 * one of those is a primitive that already exists, so every one of them was a
 * place this page could drift from the rest of the dashboard — and had. It is
 * composed from `SectionCard`/`EmptyState`/`Field`/`Checkbox` now, and the
 * search/group chrome is the only markup it owns.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SearchIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";
import { EmptyState, LoadingSkeleton, SectionCard, SectionCardSkeleton, cardClass } from "../page-chrome";
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
import {
  BrandSalesView,
  ConsignorStatementsView,
  DeadStockView,
  LayawayBookView,
  LowStockView,
  NearExpiryView,
  RepairsView,
  VariantSalesView,
  WarrantyRegisterView,
  WeightReconciliationView,
  type BrandSalesReport,
  type ConsignorStatementsReport,
  type DeadStockReport,
  type LayawayBookReport,
  type LowStockReport,
  type NearExpiryReport,
  type RepairsReport,
  type VariantSalesReport,
  type WarrantyReport,
  type WeightReconciliationReport,
} from "./trade-report-views";
import { rowsToChartData, type ChartType, type ReportRow } from "./report-ui";

/** Mirrors `ReportShape` in src/lib/reports.ts — the server tells us which view renders the payload. */
type ReportShape =
  | "rows"
  | "profit_and_loss"
  | "balance_sheet"
  | "cash_flow"
  | "food_cost_variance"
  | "weight_reconciliation"
  | "consignor_statements"
  | "layaway_book"
  | "warranty"
  | "repairs"
  | "variant_sales"
  | "brand_sales"
  | "near_expiry"
  | "low_stock"
  | "dead_stock";

interface StandardReportDef {
  key: string;
  label: string;
  description: string | null;
  group: string;
  groupLabel: string;
  shape: ReportShape;
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

/**
 * Reports whose payload is a structured document rather than a row dump — the
 * ledger statements and every trade report. They are fetched from
 * `/api/reports/standard/[key]` (which computes them) rather than posted to
 * `/api/reports/query` (which only ever aggregates a view).
 */
const DOCUMENT_SHAPES = new Set<ReportShape>([
  "profit_and_loss",
  "balance_sheet",
  "cash_flow",
  "food_cost_variance",
  "weight_reconciliation",
  "consignor_statements",
  "layaway_book",
  "warranty",
  "repairs",
  "variant_sales",
  "brand_sales",
  "near_expiry",
  "low_stock",
  "dead_stock",
]);

/**
 * Which reports accept `?compare=1`. Food-cost variance is deliberately absent:
 * it is a period total against the ledger, not a per-account rollup, and its
 * "worst item" ranking has no obvious side-by-side presentation. The trade
 * reports are absent for the same kind of reason — a warranty register is a
 * register, not a period figure.
 */
const COMPARABLE_SHAPES = new Set<ReportShape>(["profit_and_loss", "balance_sheet", "cash_flow"]);

/** Reports with nothing period-shaped to bound: a stock level or a register is "as of now". */
const UNDATED_SHAPES = new Set<ReportShape>([
  "weight_reconciliation",
  "consignor_statements",
  "layaway_book",
  "near_expiry",
  "low_stock",
  "dead_stock",
]);

/**
 * Reports that are a snapshot at one instant, not a flow over a period — they
 * read one as-of date, so an «از تاریخ» field would be a dead control (the
 * balance sheet's route never reads dateFrom; the warranty register reads
 * only its as-of date). They get a single date picker, and the balance
 * sheet's period-compare takes a second, explicitly-chosen snapshot date.
 */
const AS_OF_DATE_SHAPES = new Set<ReportShape>(["balance_sheet", "warranty"]);

/** The export API only knows these kinds; everything else has no export path yet. */
const EXPORT_KIND_BY_SHAPE: Partial<Record<ReportShape, "pnl" | "balance_sheet" | "cash_flow">> = {
  profit_and_loss: "pnl",
  balance_sheet: "balance_sheet",
  cash_flow: "cash_flow",
};

type ReportPayload = Record<string, unknown>;

/**
 * Headline figures of a document-shaped report (a statement, not a row dump)
 * as one readable sentence — what the assistant gets asked to explain. The
 * comparison payload wraps the current period under `current`, so unwrap it
 * first. Unknown shapes contribute nothing rather than fabricated numbers.
 */
function documentFacts(document: ReportPayload, shape: ReportShape): string {
  const root =
    typeof document === "object" && document !== null && "current" in document
      ? (document.current as ReportPayload)
      : document;
  if (typeof root !== "object" || root === null) return "";
  const parts: string[] = [];
  const figure = (key: string, label: string) => {
    const value = root[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${label}: ${value.toLocaleString("fa-IR")}`);
    }
  };
  switch (shape) {
    case "profit_and_loss":
      figure("totalRevenue", "جمع درآمدها");
      figure("totalExpenses", "جمع هزینه‌ها");
      figure("costOfSales", "بهای تمام‌شده");
      figure("netIncome", "سود (زیان) خالص");
      break;
    case "balance_sheet":
      figure("totalAssets", "جمع دارایی‌ها");
      figure("totalLiabilities", "جمع بدهی‌ها");
      figure("totalEquity", "جمع حقوق صاحبان سرمایه");
      if (typeof root.balanced === "boolean") {
        parts.push(root.balanced ? "وضعیت تراز: متوازن" : "وضعیت تراز: نامتوازن");
      }
      break;
    case "cash_flow":
      figure("openingCash", "موجودی ابتدای دوره");
      figure("closingCash", "موجودی پایان دوره");
      figure("netChange", "تغییر خالص وجه نقد");
      break;
    case "food_cost_variance":
      figure("theoreticalCost", "بهای نظری");
      figure("actualCogs", "بهای تمام‌شده واقعی");
      figure("variance", "مابه‌التفاوت");
      break;
  }
  return parts.join("؛ ");
}

export function StandardReportsSection({ canExplain }: { canExplain: boolean }) {
  const [reports, setReports] = useState<StandardReportDef[] | null>(null);
  const [views, setViews] = useState<ViewMeta[]>([]);
  const [savedIds, setSavedIds] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<StandardReportDef | null>(null);
  const [search, setSearch] = useState("");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [compare, setCompare] = useState(false);
  /** The balance sheet's comparison snapshot date — a snapshot has no «دورهٔ قبل» of known length the way a flow does, so the person picks the second as-of date directly. */
  const [compareAsOf, setCompareAsOf] = useState("");
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [document, setDocument] = useState<ReportPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  /**
   * Monotonic id for the in-flight report fetch. Every change of report,
   * date or compare flag starts a new request while the old one may still be
   * in flight; without this guard a slow earlier response lands *after* the
   * newer one and the screen shows the previous report's numbers under the
   * newly selected report's title.
   */
  const requestSeq = useRef(0);

  useEffect(() => {
    fetch("/api/reports/standard")
      .then((response) => response.json())
      .then((data) => setReports(data.reports ?? []))
      .catch(() => setReports([]));
    fetch("/api/reports/views")
      .then((response) => response.json())
      .then((data) => setViews(data.views ?? []))
      .catch(() => setViews([]));
    fetch("/api/reports/saved")
      .then((response) => response.json())
      .then((data) => {
        const map = new Map<string, string>();
        for (const report of (data.reports ?? []) as SavedReportRow[]) {
          if (report.standard_key) map.set(report.standard_key, report.id);
        }
        setSavedIds(map);
      })
      .catch(() => {});
  }, []);

  const isDocument = selected ? DOCUMENT_SHAPES.has(selected.shape) : false;
  const hasDateColumn = selected?.config
    ? Boolean(views.find((view) => view.key === selected.config!.view)?.hasDateColumn)
    : false;
  const acceptsDateRange = selected
    ? (isDocument && !UNDATED_SHAPES.has(selected.shape)) || hasDateColumn
    : false;
  const canCompare = selected ? COMPARABLE_SHAPES.has(selected.shape) : false;
  /** Snapshot-shaped reports take one as-of date, never a period (AS_OF_DATE_SHAPES). */
  const isAsOfDate = selected ? AS_OF_DATE_SHAPES.has(selected.shape) : false;

  const load = useCallback(async () => {
    if (!selected) return;
    const seq = ++requestSeq.current;
    setLoadError("");
    if (DOCUMENT_SHAPES.has(selected.shape)) {
      const params = new URLSearchParams();
      // A snapshot-shaped report reads one as-of date, so it gets no «از
      // تاریخ» (see AS_OF_DATE_SHAPES) and none is sent.
      if (dateFrom && !AS_OF_DATE_SHAPES.has(selected.shape)) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (compare && COMPARABLE_SHAPES.has(selected.shape)) {
        // P&L/Cash Flow mirror the range's length server-side; the Balance
        // Sheet can only compare two explicit as-of dates, so without the
        // comparison date the checkbox must not silently produce the same
        // single-snapshot report — it runs plain until a date is chosen.
        if (selected.shape === "balance_sheet") {
          if (compareAsOf) {
            params.set("compare", "1");
            params.set("previousAsOfDate", compareAsOf);
          }
        } else {
          params.set("compare", "1");
        }
      }
      try {
        const response = await fetch(`/api/reports/standard/${selected.key}?${params}`);
        const data = await response.json();
        if (seq !== requestSeq.current) return;
        if (!response.ok) {
          setLoadError("خواندن این گزارش ممکن نشد.");
          return;
        }
        const payload = data.report ?? data.comparison ?? null;
        // A 200 with neither a report nor a comparison (e.g. the route's
        // row-dump fallback answering a document-shaped request) used to
        // leave the loading skeleton on screen for ever — there is nothing
        // to render, so say so instead.
        if (payload === null) {
          setLoadError("نتیجه‌ای برای این گزارش یافت نشد.");
          return;
        }
        setDocument(payload);
        setRows(null);
      } catch {
        if (seq !== requestSeq.current) return;
        setLoadError("خواندن این گزارش ممکن نشد.");
      }
      return;
    }
    const config = {
      ...selected.config,
      filters: { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined },
    };
    try {
      const response = await fetch("/api/reports/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await response.json();
      if (seq !== requestSeq.current) return;
      if (!response.ok) {
        setLoadError("خواندن این گزارش ممکن نشد.");
        return;
      }
      setRows(data.rows ?? []);
      setDocument(null);
    } catch {
      if (seq !== requestSeq.current) return;
      setLoadError("خواندن این گزارش ممکن نشد.");
    }
  }, [selected, dateFrom, dateTo, compare, compareAsOf]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Grouped, and filtered by the search box. The search matches the label and
   * the description, because an owner looking for "چه چیزی می‌فروشد" types a
   * word from the sentence, not the report's name.
   */
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matching = (reports ?? []).filter(
      (report) =>
        !needle ||
        report.label.toLowerCase().includes(needle) ||
        (report.description ?? "").toLowerCase().includes(needle),
    );
    const byGroup = new Map<string, { label: string; reports: StandardReportDef[] }>();
    for (const report of matching) {
      const entry = byGroup.get(report.group) ?? { label: report.groupLabel, reports: [] };
      entry.reports.push(report);
      byGroup.set(report.group, entry);
    }
    return [...byGroup.entries()].map(([key, value]) => ({ key, ...value }));
  }, [reports, search]);

  const totalCount = reports?.length ?? 0;
  const matchCount = groups.reduce((sum, group) => sum + group.reports.length, 0);

  function select(report: StandardReportDef) {
    setSelected(report);
    setChartType(report.chartType ?? "bar");
    setDateFrom("");
    setDateTo("");
    setCompare(false);
    setCompareAsOf("");
    setRows(null);
    setDocument(null);
    setLoadError("");
  }

  function explainSelectedReport() {
    if (!selected) return;
    const facts = rows
      ? rowsToChartData(rows)
          .slice(0, 8)
          .map((row) => `${row.label}: ${row.value.toLocaleString("fa-IR")}`)
          .join("؛ ")
      : // The ledger statements are documents, not rows — without this the
        // assistant prompt carried no figures at all for exactly the reports
        // the button exists for (سود و زیان، ترازنامه، گردش وجوه نقد).
        document
        ? documentFacts(document, selected.shape)
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
    return <SectionCardSkeleton rows={5} label="در حال بارگذاری گزارش‌های آماده" />;
  }

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(15rem,17rem)_minmax(0,1fr)] lg:items-start lg:gap-5">
      <aside className={cn("min-w-0 overflow-hidden lg:sticky lg:top-5", cardClass)}>
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">کتابخانهٔ گزارش</p>
          <h2 className="mt-1 font-semibold text-foreground">گزارش‌های آماده</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            گزارش‌های مشترک، به‌همراه گزارش‌های ویژهٔ کسب‌وکار شما.
          </p>
          <div className="relative mt-3">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
            />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="جستجوی گزارش"
              aria-label="جستجوی گزارش"
              className={cn(inputClass, "ps-9")}
            />
          </div>
        </div>

        <nav aria-label="فهرست گزارش‌های آماده" className="p-2 lg:max-h-[calc(100dvh-19rem)] lg:overflow-y-auto">
          {groups.map((group) => (
            <div key={group.key} className="mb-3 last:mb-0">
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.reports.map((report) => {
                  const isSelected = selected?.key === report.key;
                  return (
                    <button
                      key={report.key}
                      type="button"
                      aria-current={isSelected ? "page" : undefined}
                      onClick={() => select(report)}
                      className={cn(
                        "flex min-h-11 w-full items-center rounded-xl px-3 py-2 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40",
                        isSelected
                          ? "bg-amber-100 font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <span className="min-w-0 flex-1">{report.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {matchCount === 0 ? (
            <div className="p-2">
              <EmptyState>
                {totalCount === 0
                  ? "گزارش آماده‌ای برای این کسب‌وکار تعریف نشده است."
                  : "گزارشی با این نام پیدا نشد."}
              </EmptyState>
            </div>
          ) : null}
        </nav>
      </aside>

      <div className="min-w-0" aria-live="polite">
        {!selected ? (
          <SectionCard title="پیش‌نمایش گزارش" description="برای دیدن نتیجه، یک گزارش را از فهرست انتخاب کنید.">
            <EmptyState>یک گزارش را از فهرست انتخاب کنید.</EmptyState>
          </SectionCard>
        ) : (
          <div className="min-w-0 space-y-4 sm:space-y-5">
            <SectionCard
              title={selected.label}
              description={selected.description ?? undefined}
              footer={`گروه: ${selected.groupLabel}`}
            >
              {acceptsDateRange || selected.chartType ? (
                <div className="grid gap-4">
                  {acceptsDateRange ? (
                    <>
                      {isAsOfDate ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="block">
                            <span className="mb-1.5 block text-sm font-medium text-foreground">تا تاریخ</span>
                            <JalaliDatePicker
                              value={dateTo}
                              onChange={setDateTo}
                              placeholder="تا تاریخ"
                              className={inputClass}
                            />
                          </label>
                          {selected.shape === "balance_sheet" && compare ? (
                            <label className="block">
                              <span className="mb-1.5 block text-sm font-medium text-foreground">تاریخ مقایسه</span>
                              <JalaliDatePicker
                                value={compareAsOf}
                                onChange={setCompareAsOf}
                                placeholder="تاریخ مقایسه"
                                className={inputClass}
                              />
                            </label>
                          ) : null}
                        </div>
                      ) : (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="block">
                            <span className="mb-1.5 block text-sm font-medium text-foreground">از تاریخ</span>
                            <JalaliDatePicker
                              value={dateFrom}
                              onChange={setDateFrom}
                              placeholder="از تاریخ"
                              className={inputClass}
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-sm font-medium text-foreground">تا تاریخ</span>
                            <JalaliDatePicker
                              value={dateTo}
                              onChange={setDateTo}
                              placeholder="تا تاریخ"
                              className={inputClass}
                            />
                          </label>
                        </div>
                      )}
                      <BusinessDayRangePresets
                        onSelect={(range) => {
                          if (isAsOfDate) {
                            setDateTo(range.dateTo);
                          } else {
                            setDateFrom(range.dateFrom);
                            setDateTo(range.dateTo);
                          }
                        }}
                        onClear={() => {
                          setDateFrom("");
                          setDateTo("");
                          setCompareAsOf("");
                        }}
                      />
                      {selected.shape === "balance_sheet" && compare && !compareAsOf ? (
                        <p className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                          برای مقایسه، «تاریخ مقایسه» را انتخاب کنید؛ ترازنامه تصویر یک تاریخ است و دورهٔ قبلی‌اش به‌خودی‌خود مشخص نمی‌شود.
                        </p>
                      ) : null}
                    </>
                  ) : null}

                  {selected.chartType ? (
                    <label className="block sm:max-w-xs">
                      <span className="mb-1.5 block text-sm font-medium text-foreground">نوع نمایش</span>
                      <SearchableSelect
                        className={inputClass}
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

                  {canCompare ? (
                    <label className="flex min-h-11 w-fit cursor-pointer items-center gap-3 rounded-xl border border-border/80 bg-muted px-3 text-sm text-foreground">
                      <Checkbox checked={compare} onCheckedChange={(value) => setCompare(value === true)} />
                      مقایسه با دورهٔ قبل
                    </label>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  این گزارش وضعیت لحظه‌ای را نشان می‌دهد و بازهٔ تاریخ نمی‌گیرد.
                </p>
              )}
            </SectionCard>

            <ReportBody
              report={selected}
              rows={rows}
              document={document}
              chartType={chartType}
              dateFrom={dateFrom}
              dateTo={dateTo}
              error={loadError}
            />

            <SectionCard title="خروجی و اشتراک‌گذاری">
              <div className="flex flex-wrap items-center gap-2">
                {selected.shape === "rows" || EXPORT_KIND_BY_SHAPE[selected.shape] ? (
                  <ExportButtons
                    request={
                      EXPORT_KIND_BY_SHAPE[selected.shape]
                        ? {
                            title: selected.label,
                            kind: EXPORT_KIND_BY_SHAPE[selected.shape],
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
                ) : (
                  <p className="text-sm text-muted-foreground">
                    برای این گزارش هنوز خروجی فایل تعریف نشده است.
                  </p>
                )}
                {canExplain && (rows !== null || document !== null) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    onClick={explainSelectedReport}
                    className="min-h-11 gap-1.5 border-amber-200 bg-amber-50 px-3 font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300 dark:hover:bg-amber-500/20"
                  >
                    <SparklesIcon className="size-4" aria-hidden="true" /> توضیح این عدد
                  </Button>
                ) : null}
                {selected.chartType && savedIds.has(selected.key) ? (
                  <PinToDashboardButton
                    savedReportId={savedIds.get(selected.key)!}
                    chartType={chartType}
                    title={selected.label}
                  />
                ) : null}
              </div>
            </SectionCard>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The result itself. Split out so the shape→view mapping is one readable
 * table rather than a nested ternary inside the page's layout.
 */
function ReportBody({
  report,
  rows,
  document,
  chartType,
  dateFrom,
  dateTo,
  error,
}: {
  report: StandardReportDef;
  rows: ReportRow[] | null;
  document: ReportPayload | null;
  chartType: ChartType;
  dateFrom: string;
  dateTo: string;
  error: string;
}) {
  if (error) {
    return (
      <SectionCard title="نتیجهٔ گزارش">
        <EmptyState>{error}</EmptyState>
      </SectionCard>
    );
  }

  if (DOCUMENT_SHAPES.has(report.shape)) {
    if (document === null) {
      return (
        <SectionCard title="نتیجهٔ گزارش">
          <LoadingSkeleton rows={4} label={`در حال خواندن ${report.label}`} />
        </SectionCard>
      );
    }

    // The ledger statements keep their own padded card: they are documents with
    // internal sections, not a single table.
    switch (report.shape) {
      case "profit_and_loss":
        return (
          <SectionCard title="نتیجهٔ گزارش">
            <ProfitAndLossView
              report={document as unknown as ProfitAndLoss | Comparison<ProfitAndLoss>}
              dateFrom={dateFrom || undefined}
              dateTo={dateTo || undefined}
            />
          </SectionCard>
        );
      case "balance_sheet":
        return (
          <SectionCard title="نتیجهٔ گزارش">
            <BalanceSheetView
              report={document as unknown as BalanceSheet | Comparison<BalanceSheet>}
              dateTo={dateTo || undefined}
            />
          </SectionCard>
        );
      case "cash_flow":
        return (
          <SectionCard title="نتیجهٔ گزارش">
            <CashFlowView report={document as unknown as CashFlow | Comparison<CashFlow>} />
          </SectionCard>
        );
      case "food_cost_variance":
        return (
          <SectionCard title="نتیجهٔ گزارش">
            <FoodCostVarianceView report={document as unknown as FoodCostVariance} />
          </SectionCard>
        );
    }

    // The trade reports are each one table, so they sit in a flush card that
    // lets the rows reach its edges (docs/design-system.md §Tables).
    return (
      <SectionCard title="نتیجهٔ گزارش" flush>
        <TradeReportBody shape={report.shape} payload={document} />
      </SectionCard>
    );
  }

  if (rows === null) {
    return (
      <SectionCard title="نتیجهٔ گزارش">
        <LoadingSkeleton rows={4} label={`در حال خواندن ${report.label}`} />
      </SectionCard>
    );
  }

  const data = rowsToChartData(rows);
  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <SectionCard title="نمودار">
        <ChartPreview chartType={chartType} data={data} label={report.label} />
      </SectionCard>
      <SectionCard title="داده‌های گزارش" flush>
        <DataTable columns={["بُعد", "مقدار"]} data={data} />
      </SectionCard>
    </div>
  );
}

function TradeReportBody({ shape, payload }: { shape: ReportShape; payload: ReportPayload }) {
  switch (shape) {
    case "weight_reconciliation":
      return <WeightReconciliationView report={payload as unknown as WeightReconciliationReport} />;
    case "consignor_statements":
      return <ConsignorStatementsView report={payload as unknown as ConsignorStatementsReport} />;
    case "layaway_book":
      return <LayawayBookView report={payload as unknown as LayawayBookReport} />;
    case "warranty":
      return <WarrantyRegisterView report={payload as unknown as WarrantyReport} />;
    case "repairs":
      return <RepairsView report={payload as unknown as RepairsReport} />;
    case "variant_sales":
      return <VariantSalesView report={payload as unknown as VariantSalesReport} />;
    case "brand_sales":
      return <BrandSalesView report={payload as unknown as BrandSalesReport} />;
    case "near_expiry":
      return <NearExpiryView report={payload as unknown as NearExpiryReport} />;
    case "low_stock":
      return <LowStockView report={payload as unknown as LowStockReport} />;
    case "dead_stock":
      return <DeadStockView report={payload as unknown as DeadStockReport} />;
    default:
      return <EmptyState>نمایش این گزارش پشتیبانی نمی‌شود.</EmptyState>;
  }
}
