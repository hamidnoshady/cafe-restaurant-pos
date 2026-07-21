"use client";

import { useEffect, useMemo, useState } from "react";
import { ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "../ui";
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
  config: { view: string; metric: string; aggregation: Aggregation; dimension: string; filters?: { dateFrom?: string; dateTo?: string } };
  is_standard: boolean;
}

const AGG_LABELS: Record<Aggregation, string> = { sum: "جمع", avg: "میانگین", count: "تعداد" };

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
    fetch("/api/reports/saved").then((r) => r.json()).then((d) => setSaved(d.reports ?? []));
  }

  useEffect(() => {
    fetch("/api/reports/views").then((r) => r.json()).then((d) => {
      const list: ViewMeta[] = d.views ?? [];
      setViews(list);
      if (list.length > 0) {
        setView(list[0].key);
        setMetric(list[0].metrics[0]?.key ?? "");
        setDimension(list[0].dimensions[0]?.key ?? "");
      }
    });
    loadSaved();
  }, []);

  const currentView = useMemo(() => views?.find((v) => v.key === view) ?? null, [views, view]);
  const currentMetric = useMemo(() => currentView?.metrics.find((m) => m.key === metric) ?? null, [currentView, metric]);

  function selectView(key: string) {
    setView(key);
    const v = views?.find((x) => x.key === key);
    setMetric(v?.metrics[0]?.key ?? "");
    setDimension(v?.dimensions[0]?.key ?? "");
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
    const res = await fetch("/api/reports/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentConfig()),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
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
    const url = editingId ? `/api/reports/saved/${editingId}` : "/api/reports/saved";
    const res = await fetch(url, {
      method: editingId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, config: currentConfig() }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
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
    await fetch(`/api/reports/saved/${id}`, { method: "DELETE" });
    loadSaved();
  }

  if (!views) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-4 font-semibold">گزارش‌ساز</h2>
        <ErrorBox>{error}</ErrorBox>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="منبع داده">
            <select className={inputClass} value={view} onChange={(e) => selectView(e.target.value)}>
              {views.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="معیار">
            <select className={inputClass} value={metric} onChange={(e) => setMetric(e.target.value)}>
              {currentView?.metrics.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="نوع تجمیع">
            <select className={inputClass} value={aggregation} onChange={(e) => setAggregation(e.target.value as Aggregation)}>
              {(currentMetric?.aggregations ?? ["sum"]).map((a) => (
                <option key={a} value={a}>
                  {AGG_LABELS[a]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="بُعد">
            <select className={inputClass} value={dimension} onChange={(e) => setDimension(e.target.value)}>
              {currentView?.dimensions.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {currentView?.hasDateColumn ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">بازهٔ تاریخ:</span>
            <input type="date" dir="ltr" className={inputClass} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <span className="text-xs text-muted-foreground">تا</span>
            <input type="date" dir="ltr" className={inputClass} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <PrimaryButton type="button" onClick={preview} disabled={busy}>
            پیش‌نمایش
          </PrimaryButton>
          <select className={inputClass} value={chartType} onChange={(e) => setChartType(e.target.value as ChartType)}>
            <option value="bar">میله‌ای</option>
            <option value="line">خطی</option>
            <option value="pie">دایره‌ای</option>
            <option value="number">عدد</option>
          </select>
          <input
            className={`${inputClass} max-w-56`}
            placeholder="نام گزارش برای ذخیره"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <SecondaryButton onClick={save} disabled={busy}>
            {editingId ? "به‌روزرسانی گزارش" : "ذخیرهٔ گزارش"}
          </SecondaryButton>
          {editingId ? (
            <SecondaryButton
              onClick={() => {
                setEditingId(null);
                setName("");
              }}
            >
              انصراف از ویرایش
            </SecondaryButton>
          ) : null}
        </div>

        {rows !== null ? (
          <div className="mt-5 space-y-4 border-t pt-4">
            <ChartPreview chartType={chartType} data={rowsToChartData(rows)} label={name || currentView?.label || ""} />
            <DataTable columns={["بُعد", "مقدار"]} data={rowsToChartData(rows)} />
            <ExportButtons request={{ title: name || currentView?.label || "گزارش", kind: "chart", config: currentConfig() }} />
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-4 font-semibold">گزارش‌های سفارشی ذخیره‌شده</h2>
        <ul className="divide-y divide-border">
          {(saved ?? []).filter((r) => !r.is_standard).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <span className="text-sm font-medium">{r.name}</span>
              <div className="flex flex-wrap items-center gap-2">
                <SecondaryButton onClick={() => loadIntoBuilder(r)}>ویرایش</SecondaryButton>
                <PinToDashboardButton savedReportId={r.id} chartType="bar" title={r.name} />
                <SecondaryButton onClick={() => remove(r.id)}>حذف</SecondaryButton>
              </div>
            </li>
          ))}
          {(saved ?? []).filter((r) => !r.is_standard).length === 0 ? (
            <li className="py-3 text-sm text-muted-foreground">هنوز گزارش سفارشی‌ای ذخیره نشده است.</li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
