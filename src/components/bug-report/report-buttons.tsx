"use client";

import { BugIcon } from "lucide-react";
import { useBugReport } from "./bug-report-provider";

/**
 * The small "bug" controls that live in a footer.
 *
 * `"sidebar"` is the full-width, bordered row for the desktop sidebar footer —
 * styled to match `LogoutButton` and the other per-device switches that sit
 * there. `"bottomnav"` is the icon-only trailing slot of the phone's bottom
 * bar, the same shape as the page links around it.
 */
export function BugReportFooterButton({ variant = "sidebar" }: { variant?: "sidebar" | "bottomnav" }) {
  const { openReport } = useBugReport();

  if (variant === "bottomnav") {
    return (
      <button
        type="button"
        onClick={openReport}
        aria-label="گزارش مشکل"
        title="گزارش مشکل"
        className="flex min-h-14 w-14 shrink-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 active:scale-[0.98]"
      >
        <BugIcon aria-hidden="true" className="size-5 shrink-0" />
        <span className="max-w-full truncate">گزارش</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={openReport}
      className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg border border-input py-1.5 text-sm text-muted-foreground transition hover:bg-muted/50"
    >
      <BugIcon aria-hidden="true" className="size-4 shrink-0" />
      گزارش خطا
    </button>
  );
}
