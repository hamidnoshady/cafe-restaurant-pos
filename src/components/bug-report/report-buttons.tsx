"use client";

import { BugIcon } from "lucide-react";
import { useBugReport } from "./bug-report-provider";

/** The compact bug-report control at the bottom of the dashboard sidebar. */
export function BugReportFooterButton() {
  const { openReport } = useBugReport();

  return (
    <button
      type="button"
      onClick={openReport}
      aria-label="گزارش مشکل"
      title="گزارش مشکل"
      className="mb-1 ms-auto flex size-9 items-center justify-center rounded-lg border border-input text-muted-foreground transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 active:scale-[0.98] group-data-[state=collapsed]/sidebar:mx-auto"
    >
      <BugIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="sr-only">گزارش مشکل</span>
    </button>
  );
}
