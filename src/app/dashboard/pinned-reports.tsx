"use client";

import { useState } from "react";
import { DashboardGrid } from "./dashboard-grid";

/** Keeps the existing personalized report widgets available without competing with the operational overview. */
export function PinnedReports({ canEdit, canExplain }: { canEdit: boolean; canExplain: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="mt-6 rounded-2xl border border-border/80 bg-card px-4 py-1.5 shadow-[0_1px_2px_rgb(15_23_42/0.03)]" aria-labelledby="pinned-reports-heading">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls="pinned-reports-content"
        className="flex min-h-11 w-full items-center justify-between gap-3 py-2 text-right text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98]"
      >
        <span id="pinned-reports-heading">گزارش‌های سنجاق‌شده <span className="mr-2 text-xs font-normal text-muted-foreground">چیدمان و گزارش‌های شخصی شما</span></span>
        <span className="shrink-0 text-xs font-medium text-muted-foreground">{open ? "بستن" : "باز کردن"}</span>
      </button>
      {open ? <div id="pinned-reports-content" className="border-t border-border/80 py-4"><DashboardGrid canEdit={canEdit} canExplain={canExplain} /></div> : null}
    </section>
  );
}
