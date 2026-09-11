"use client";

import { useState } from "react";
import { CheckIcon, PinIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ChartType } from "./report-ui";

interface ExistingWidget {
  id: string;
  saved_report_id: string;
  chart_type: ChartType;
  title: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Adds a report to the caller's personal dashboard as a new widget, appended below whatever's already pinned. */
export function PinToDashboardButton({
  savedReportId,
  chartType,
  title,
}: {
  savedReportId: string;
  chartType: ChartType;
  title: string;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(
    "idle",
  );

  async function pin() {
    setState("busy");
    try {
      const current = await fetch("/api/dashboard/widgets").then((response) =>
        response.json(),
      );
      const existing: ExistingWidget[] = current.widgets ?? [];
      const nextY = existing.reduce(
        (maximum, widget) => Math.max(maximum, widget.y + widget.h),
        0,
      );
      const widgets = [
        ...existing.map((widget) => ({
          savedReportId: widget.saved_report_id,
          chartType: widget.chart_type,
          title: widget.title,
          x: widget.x,
          y: widget.y,
          w: widget.w,
          h: widget.h,
        })),
        { savedReportId, chartType, title, x: 0, y: nextY, w: 4, h: 3 },
      ];
      const response = await fetch("/api/dashboard/widgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "personal", widgets }),
      });
      setState(response.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="lg"
        onClick={pin}
        disabled={state === "busy" || state === "done"}
      >
        {state === "done" ? <CheckIcon aria-hidden="true" /> : <PinIcon aria-hidden="true" />}
        {state === "done" ? "سنجاق شد" : state === "busy" ? "در حال سنجاق…" : "سنجاق به داشبورد"}
      </Button>
      {/*
        Pinning succeeds silently otherwise: the widget appears on a different
        page, so without a word here the button looks like it did nothing.
      */}
      {state === "done" ? (
        <span role="status" className="text-xs text-muted-foreground">
          در «گزارش‌های سنجاق‌شده» داشبورد اضافه شد.
        </span>
      ) : null}
      {state === "error" ? (
        <span role="alert" className="text-xs text-destructive">
          سنجاق کردن انجام نشد.
        </span>
      ) : null}
    </div>
  );
}
