"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GridLayout, useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";
import { XIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { api, ErrorBox } from "./ui";
import { BarChart, LineChart, NumberCard, PieChart, type ChartDatum } from "./charts";

type ChartType = "line" | "bar" | "pie" | "number";

interface WidgetRow {
  id: string;
  saved_report_id: string;
  chart_type: ChartType;
  title: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  report_name: string;
  report_config: Record<string, unknown>;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function formatDim(dim: string | null): string {
  if (dim === null) return "";
  if (ISO_DATE_RE.test(dim)) return toPersianDigits(formatJalali(dim));
  return dim;
}

function useWidgetData(config: Record<string, unknown>) {
  const [data, setData] = useState<ChartDatum[] | null>(null);
  const configKey = JSON.stringify(config);
  useEffect(() => {
    let cancelled = false;
    api<{ rows?: { dim: string | null; value: string | number | null }[] }>("/api/reports/query", {
      method: "POST",
      body: configKey,
    }).then(({ ok, data: res }) => {
      if (cancelled) return;
      if (ok && res.rows) {
        setData(res.rows.map((r) => ({ label: formatDim(r.dim), value: Number(r.value) || 0 })));
      } else {
        setData([]);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);
  return data;
}

function WidgetBody({ widget }: { widget: WidgetRow }) {
  const data = useWidgetData(widget.report_config);
  if (data === null) return <p className="p-2 text-xs text-muted-foreground">در حال بارگذاری…</p>;

  if (widget.chart_type === "number") {
    const total = data.reduce((s, d) => s + d.value, 0);
    return <NumberCard label={widget.title ?? widget.report_name} value={toPersianDigits(Math.round(total).toLocaleString("en-US"))} />;
  }
  if (widget.chart_type === "line") return <LineChart data={data} />;
  if (widget.chart_type === "pie") return <PieChart data={data} />;
  return <BarChart data={data} />;
}

// Below this container width the 12-column grid is too cramped to be usable —
// widgets get sub-30px columns and their content overflows — so we collapse to
// a single full-width column and stack the tiles in reading order instead.
const STACK_MAX_WIDTH = 640;

export function DashboardGrid({ canEdit }: { canEdit: boolean }) {
  const { width, containerRef, mounted } = useContainerWidth();
  const [widgets, setWidgets] = useState<WidgetRow[] | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [error, setError] = useState("");

  const stacked = mounted && width > 0 && width < STACK_MAX_WIDTH;
  const cols = stacked ? 1 : 12;
  // Editing (drag/resize) persists positions in 12-column coordinates, so we
  // only allow it on the full grid — never in the stacked mobile view, whose
  // one-column layout would otherwise clobber the saved desktop arrangement.
  const canEditLayout = canEdit && !stacked;

  const load = useCallback(() => {
    api<{ widgets: WidgetRow[] }>("/api/dashboard/widgets").then(({ ok, data }) => {
      if (ok) setWidgets(data.widgets);
    });
  }, []);
  useEffect(load, [load]);

  const layout: Layout = useMemo(() => {
    const items = widgets ?? [];
    if (stacked) {
      // Full-width tiles stacked top-to-bottom in the saved reading order.
      let y = 0;
      return [...items]
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((w) => {
          const h = Math.max(w.h, 3);
          const item = { i: w.id, x: 0, y, w: 1, h, minW: 1, minH: 2 };
          y += h;
          return item;
        });
    }
    return items.map((w) => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: 2, minH: 2 }));
  }, [widgets, stacked]);

  async function persist(next: WidgetRow[]) {
    setWidgets(next);
    const { ok, data } = await api<{ error?: string }>("/api/dashboard/widgets", {
      method: "POST",
      body: JSON.stringify({
        scope: "personal",
        widgets: next.map((w) => ({
          savedReportId: w.saved_report_id,
          chartType: w.chart_type,
          title: w.title,
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
        })),
      }),
    });
    if (!ok) setError(data.error ?? "خطای غیرمنتظره در ذخیرهٔ چیدمان.");
  }

  function onLayoutChange(next: Layout) {
    if (!widgets || !editMode || stacked) return;
    const byId = new Map(next.map((l: LayoutItem) => [l.i, l]));
    const updated = widgets.map((w) => {
      const l = byId.get(w.id);
      return l ? { ...w, x: l.x, y: l.y, w: l.w, h: l.h } : w;
    });
    persist(updated);
  }

  function removeWidget(id: string) {
    if (!widgets) return;
    persist(widgets.filter((w) => w.id !== id));
  }

  if (widgets === null) return <p className="text-sm text-muted-foreground">در حال بارگذاری داشبورد…</p>;

  if (widgets.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        {canEdit
          ? "هنوز ابزارکی به داشبورد سنجاق نشده است. از صفحهٔ «گزارش‌ها» یک گزارش را به داشبورد سنجاق کنید."
          : "هنوز ابزارکی برای این نقش تنظیم نشده است."}
      </p>
    );
  }

  return (
    <div>
      <ErrorBox>{error}</ErrorBox>
      {canEditLayout ? (
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={() => setEditMode((v) => !v)}
            className={`rounded-lg px-3 py-1.5 text-sm ${editMode ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted"}`}
          >
            {editMode ? "پایان ویرایش چیدمان" : "ویرایش چیدمان"}
          </button>
        </div>
      ) : null}
      {/*
        react-grid-layout positions items with `transform: translate(Xpx,Ypx)`
        and no explicit left/right — under dir="rtl" the browser's fallback
        "static position" for an absolutely-positioned box with both offsets
        auto anchors from the right edge instead of the left, so every
        translate() lands far off in the wrong place. Isolating the grid to
        dir="ltr" fixes the positioning; widget content re-declares dir="rtl"
        so Persian text still reads correctly inside each tile.

        We also don't import react-grid-layout's stylesheet, so the grid root
        never picks up its `position: relative`. Without it the absolutely
        positioned tiles resolve their offsetParent to a far-up ancestor, and
        the drag math (which bases the moving tile on clientRect - offsetParent
        rect) makes the box jump away from the cursor on grab. The `relative`
        class on GridLayout below makes the grid its own offsetParent so the
        tile tracks the pointer exactly.
      */}
      <div ref={containerRef} dir="ltr">
        {mounted ? (
          <GridLayout
            className="relative"
            width={width}
            layout={layout}
            gridConfig={{ cols, rowHeight: 90, margin: [12, 12] }}
            dragConfig={{ enabled: editMode && !stacked }}
            resizeConfig={{ enabled: editMode && !stacked }}
            onDragStop={onLayoutChange}
            onResizeStop={onLayoutChange}
            autoSize
          >
            {widgets.map((w) => (
              <div key={w.id} dir="rtl" className="overflow-hidden rounded-2xl bg-card shadow-sm">
                <div className="flex items-center justify-between border-b px-3 py-1.5">
                  <p className="truncate text-xs font-semibold text-muted-foreground">{w.title ?? w.report_name}</p>
                  {editMode ? (
                    <button
                      type="button"
                      onClick={() => removeWidget(w.id)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="حذف ابزارک"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                <div className="h-[calc(100%-2rem)] p-2">
                  <WidgetBody widget={w} />
                </div>
              </div>
            ))}
          </GridLayout>
        ) : null}
      </div>
    </div>
  );
}
