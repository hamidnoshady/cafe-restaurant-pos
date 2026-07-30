"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { JalaliDatePicker } from "../jalali-date-picker";
import { ErrorBox, Field, inputClass } from "../ui";
import { ChartPreview, DataTable } from "./chart-preview";
import { ExportButtons } from "./export-buttons";
import { PinToDashboardButton } from "./pin-button";
import { rowsToChartData, type Aggregation, type ChartType, type ReportRow } from "./report-ui";

interface ViewMeta {
  key: string;
  label: string;
  hasDateColumn: boolean;
  dimensions: { key: string; label: string }[];
  metrics: { key: string; label: string; aggregations: Aggregation[] }[];
}

interface SavedReportRow {
  id: string;
  name: string;
  config: {
    view: string;
    metric: string;
    aggregation: Aggregation;
    dimension: string;
    filters?: { dateFrom?: string; dateTo?: string };
  };
  is_standard: boolean;
}

const AGG_LABELS: Record<Aggregation, string> = { sum: "جمع", avg: "میانگین", count: "تعداد" };
const CONTROL_CLASS = [inputClass, "min-h-12 border-[#DEDAD2] bg-white text-[#252522]"].join(" ");

export function ReportBuilderSection() {
  const [views, setViews] = useState<ViewMeta[] | null>(null);
  const [saved, setSaved] = useState<SavedReportRow[] | null>(null);

  const [view, setView] = useState("");
  const [metric, setMetric] = useState("");
  const [aggregation, setAggregation] = useState<Aggregation>("sum");
  const [dimension, setDimension] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function loadSaved() {
    fetch("/api/reports/saved").then((response) => response.json()).then((data) => setSaved(data.reports ?? []));
  }

  useEffect(() => {
    fetch("/api/reports/views").then((response) => response.json()).then((data) => {
      const list: ViewMeta[] = data.views ?? [];
      setViews(list);
      if (list.length > 0) {
        setView(list[0].key);
        setMetric(list[0].metrics[0]?.key ?? "");
        setDimension(list[0].dimensions[0]?.key ?? "");
      }
    });
    loadSaved();
  }, []);

  const currentView = useMemo(() => views?.find((item) => item.key === view) ?? null, [views, view]);
  const currentMetric = useMemo(
    () => currentView?.metrics.find((item) => item.key === metric) ?? null,
    [currentView, metric],
  );
  const customReports = (saved ?? []).filter((report) => !report.is_standard);

  function selectView(key: string) {
    setView(key);
    const nextView = views?.find((item) => item.key === key);
    setMetric(nextView?.metrics[0]?.key ?? "");
    setDimension(nextView?.dimensions[0]?.key ?? "");
    setRows(null);
  }

  function currentConfig() {
    return {
      view,
      metric,
      aggregation,
      dimension,
      filters: { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined },
    };
  }

  async function preview() {
    setBusy(true);
    setError("");
    const response = await fetch("/api/reports/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentConfig()),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(data.details?.join(" ") ?? "پیکربندی گزارش نامعتبر است.");
      return;
    }
    setRows(data.rows ?? []);
  }

  async function save() {
    if (!name.trim()) {
      setError("برای ذخیرهٔ گزارش، نامی وارد کنید.");
      return;
    }
    setBusy(true);
    setError("");
    const url = editingId ? "/api/reports/saved/" + editingId : "/api/reports/saved";
    const response = await fetch(url, {
      method: editingId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, config: currentConfig() }),
    });
    setBusy(false);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.details?.join(" ") ?? "ذخیرهٔ گزارش ناموفق بود.");
      return;
    }
    setEditingId(null);
    setName("");
    loadSaved();
  }

  function loadIntoBuilder(report: SavedReportRow) {
    setView(report.config.view);
    setMetric(report.config.metric);
    setAggregation(report.config.aggregation);
    setDimension(report.config.dimension);
    setDateFrom(report.config.filters?.dateFrom ?? "");
    setDateTo(report.config.filters?.dateTo ?? "");
    setName(report.name);
    setEditingId(report.id);
    setRows(null);
  }

  async function remove(id: string) {
    await fetch("/api/reports/saved/" + id, { method: "DELETE" });
    loadSaved();
  }

  if (!views) {
    return (
      <section
        role="status"
        aria-live="polite"
        aria-label="در حال بارگذاری گزارش‌ساز"
        className="rounded-2xl border border-[#EAE8E2] bg-white px-5 py-8 text-sm text-[#77756F] shadow-[0_1px_2px_rgb(41_37_36/0.03)]"
      >
        در حال بارگذاری…
      </section>
    );
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <section
        aria-labelledby="report-builder-heading"
        aria-busy={busy}
        className="rounded-2xl border border-[#EAE8E2] bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.03)] sm:p-5"
      >
        <header className="border-b border-[#F0EEE9] pb-4">
          <p className="text-xs font-semibold text-[#9B6700]">گزارش سفارشی</p>
          <h2 id="report-builder-heading" className="mt-1 text-lg font-bold text-[#252522]">گزارش‌ساز</h2>
          <p className="mt-1 text-sm text-[#77756F]">منبع، معیار و نحوهٔ نمایش گزارش را با داده‌های موجود تنظیم کنید.</p>
        </header>

        <div className="mt-5">
          <ErrorBox>{error}</ErrorBox>

          <div className="grid gap-x-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="منبع داده">
              <select className={CONTROL_CLASS} value={view} onChange={(event) => selectView(event.target.value)}>
                {views.map((item) => (
                  <option key={item.key} value={item.key}>{item.label}</option>
                ))}
              </select>
            </Field>

            <Field label="معیار">
              <select className={CONTROL_CLASS} value={metric} onChange={(event) => setMetric(event.target.value)}>
                {currentView?.metrics.map((item) => (
                  <option key={item.key} value={item.key}>{item.label}</option>
                ))}
              </select>
            </Field>

            <Field label="نوع تجمیع">
              <select
                className={CONTROL_CLASS}
                value={aggregation}
                onChange={(event) => setAggregation(event.target.value as Aggregation)}
              >
                {(currentMetric?.aggregations ?? ["sum"]).map((item) => (
                  <option key={item} value={item}>{AGG_LABELS[item]}</option>
                ))}
              </select>
            </Field>

            <Field label="بُعد">
              <select className={CONTROL_CLASS} value={dimension} onChange={(event) => setDimension(event.target.value)}>
                {currentView?.dimensions.map((item) => (
                  <option key={item.key} value={item.key}>{item.label}</option>
                ))}
              </select>
            </Field>
          </div>

          {currentView?.hasDateColumn ? (
            <fieldset className="mt-1 rounded-xl border border-[#EEECE7] bg-[#FCFBF8] p-3 sm:p-4">
              <legend className="px-1 text-sm font-semibold text-[#252522]">بازهٔ تاریخ</legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-[#77756F]">از تاریخ</span>
                  <JalaliDatePicker value={dateFrom} onChange={setDateFrom} placeholder="از تاریخ" className={CONTROL_CLASS} />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-[#77756F]">تا تاریخ</span>
                  <JalaliDatePicker value={dateTo} onChange={setDateTo} placeholder="تا تاریخ" className={CONTROL_CLASS} />
                </label>
              </div>
            </fieldset>
          ) : null}

          <div className="mt-5 grid gap-3 border-t border-[#F0EEE9] pt-5 lg:grid-cols-[auto_minmax(11rem,1fr)_minmax(12rem,1fr)_auto] lg:items-end">
            <Button
              type="button"
              size="lg"
              onClick={preview}
              disabled={busy}
              className="min-h-12 bg-[#E9A11B] px-5 font-bold text-[#3A290B] hover:bg-[#D9910E] focus-visible:ring-[#E9A11B]/45"
            >
              پیش‌نمایش
            </Button>

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

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-[#77756F]">نام گزارش</span>
              <input
                className={CONTROL_CLASS}
                placeholder="نام گزارش برای ذخیره"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={save}
                disabled={busy}
                className="min-h-12 border-[#DEDAD2] bg-white px-4 font-semibold text-[#252522] hover:bg-[#FCFBF8]"
              >
                {editingId ? "به‌روزرسانی گزارش" : "ذخیرهٔ گزارش"}
              </Button>
              {editingId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  onClick={() => {
                    setEditingId(null);
                    setName("");
                  }}
                  className="min-h-12 px-4 text-[#5E5B55] hover:bg-[#FCFBF8]"
                >
                  انصراف از ویرایش
                </Button>
              ) : null}
            </div>
          </div>

          {rows !== null ? (
            <section aria-label="خروجی پیش‌نمایش گزارش" className="mt-6 space-y-5 border-t border-[#F0EEE9] pt-5">
              <ChartPreview chartType={chartType} data={rowsToChartData(rows)} label={name || currentView?.label || ""} />
              <DataTable columns={["بُعد", "مقدار"]} data={rowsToChartData(rows)} />
              <div className="border-t border-[#F0EEE9] pt-4">
                <ExportButtons request={{ title: name || currentView?.label || "گزارش", kind: "chart", config: currentConfig() }} />
              </div>
            </section>
          ) : null}
        </div>
      </section>

      <section
        aria-labelledby="saved-reports-heading"
        className="rounded-2xl border border-[#EAE8E2] bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.03)] sm:p-5"
      >
        <header className="border-b border-[#F0EEE9] pb-4">
          <p className="text-xs font-semibold text-[#9B6700]">گزارش‌های شخصی</p>
          <h2 id="saved-reports-heading" className="mt-1 text-lg font-bold text-[#252522]">گزارش‌های سفارشی ذخیره‌شده</h2>
        </header>

        <ul className="divide-y divide-[#F0EEE9]">
          {saved === null ? (
            <li role="status" className="py-8 text-center text-sm text-[#77756F]">در حال بارگذاری…</li>
          ) : null}

          {customReports.map((report) => (
            <li key={report.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 break-words font-semibold text-[#252522]">{report.name}</span>
              <div className="grid shrink-0 gap-2 sm:flex sm:flex-wrap">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => loadIntoBuilder(report)}
                  className="min-h-12 border-[#DEDAD2] bg-white px-4 text-[#252522] hover:bg-[#FCFBF8]"
                >
                  ویرایش
                </Button>
                <PinToDashboardButton savedReportId={report.id} chartType="bar" title={report.name} />
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => remove(report.id)}
                  className="min-h-12 border-[#EBC4C1] bg-white px-4 text-[#B42318] hover:bg-[#FDECEC]"
                >
                  حذف
                </Button>
              </div>
            </li>
          ))}

          {saved !== null && customReports.length === 0 ? (
            <li className="py-8 text-center text-sm text-[#77756F]">هنوز گزارش سفارشی‌ای ذخیره نشده است.</li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
