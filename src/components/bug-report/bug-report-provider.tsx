"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { BugIcon } from "lucide-react";
import { useShakeDetection } from "./use-shake";
import { BugReportDialog } from "./bug-report-dialog";

/**
 * Bug reporting, wired once around the dashboard.
 *
 * Three ways in, one dialog out:
 *   - shake the phone (device motion),
 *   - the floating "report" button (mobile),
 *   - the small bug icon in the footer (sidebar footer on desktop, bottom bar
 *     on mobile).
 *
 * The provider owns the dialog's open state and the "is a screenshot being
 * captured" flag, so the floating button can hide itself while the snapshot is
 * taken. `useBugReport()` lets any descendant (the footer icon in
 * dashboard-sidebar.tsx) open the dialog without knowing the plumbing.
 */

interface BugReportContextValue {
  openReport: () => void;
}

const BugReportContext = createContext<BugReportContextValue | null>(null);

export function useBugReport(): BugReportContextValue {
  const ctx = useContext(BugReportContext);
  if (!ctx) throw new Error("useBugReport must be used within a <BugReportProvider>");
  return ctx;
}

export function BugReportProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);

  const { requestPermission } = useShakeDetection(() => {
    setOpen(true);
  });

  const openReport = useCallback(() => {
    // iOS requires a user gesture to enable device motion; tapping any report
    // control doubles as that gesture, so shake starts working from then on.
    void requestPermission();
    setOpen(true);
  }, [requestPermission]);

  const value = useMemo<BugReportContextValue>(() => ({ openReport }), [openReport]);

  return (
    <BugReportContext.Provider value={value}>
      {children}

      {/* Floating "report" button — mobile only; desktop reaches the dialog via the sidebar footer. */}
      <button
        type="button"
        onClick={openReport}
        aria-label="گزارش مشکل"
        title="گزارش مشکل"
        className={`fixed start-4 bottom-[calc(var(--app-bottom-nav)+0.75rem)] z-40 flex h-12 items-center gap-2 rounded-full bg-destructive px-4 text-sm font-semibold text-white shadow-lg shadow-destructive/30 ring-1 ring-foreground/10 transition-[transform,opacity] hover:scale-105 focus-visible:opacity-100 active:scale-95 md:hidden ${
          capturing ? "hidden" : ""
        }`}
      >
        <BugIcon aria-hidden="true" className="size-5 shrink-0" />
        گزارش خطا
      </button>

      <BugReportDialog open={open} onOpenChange={setOpen} capturing={capturing} onCapturingChange={setCapturing} />
    </BugReportContext.Provider>
  );
}
