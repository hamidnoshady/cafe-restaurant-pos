"use client";

import { useState } from "react";
import { DashboardGrid } from "./dashboard-grid";
import { cardClass } from "./page-chrome";
import { cn } from "@/lib/utils";

/** Keeps the existing personalized report widgets available without competing with the operational overview. */
export function PinnedReports({ canEdit, canExplain }: { canEdit: boolean; canExplain: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <section className={cn("mt-6 px-4 py-1.5", cardClass)} aria-labelledby="pinned-reports-heading">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls="pinned-reports-content"
        className="flex min-h-11 w-full items-center justify-between gap-3 py-2 text-start text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98]"
      >
        <span id="pinned-reports-heading">گزارش‌های سنجاق‌شده <span className="ms-2 text-xs font-normal text-muted-foreground">چیدمان و گزارش‌های شخصی شما</span></span>
        <span className="shrink-0 text-xs font-medium text-muted-foreground">{open ? "بستن" : "باز کردن"}</span>
      </button>
      {open ? <div id="pinned-reports-content" className="border-t border-border/80 py-4"><DashboardGrid canEdit={canEdit} canExplain={canExplain} /></div> : null}
    </section>
  );
}
