"use client";

import { useState } from "react";
import { SecondaryButton } from "../ui";
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
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");

  async function pin() {
    setState("busy");
    try {
      const current = await fetch("/api/dashboard/widgets").then((r) => r.json());
      const existing: ExistingWidget[] = current.widgets ?? [];
      const nextY = existing.reduce((max, w) => Math.max(max, w.y + w.h), 0);
      const widgets = [
        ...existing.map((w) => ({
          savedReportId: w.saved_report_id,
          chartType: w.chart_type,
          title: w.title,
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
        })),
        { savedReportId, chartType, title, x: 0, y: nextY, w: 4, h: 3 },
      ];
      const res = await fetch("/api/dashboard/widgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "personal", widgets }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <SecondaryButton onClick={pin} disabled={state === "busy"}>
      {state === "done" ? "سنجاق شد ✓" : state === "busy" ? "در حال سنجاق…" : "سنجاق به داشبورد"}
    </SecondaryButton>
  );
}
