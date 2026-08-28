"use client";

/**
 * The dashboard's main content area (Phase 36b revision).
 *
 * Most pages want the normal padded, pull-to-refresh scroller. The assistant
 * page (`/dashboard/ai`) is different: it is a full-height, ChatGPT-like surface
 * with its own in-app nav and a pinned composer, so it takes the whole height
 * with no padding and no mobile bottom-bar offset — the assistant provides its
 * own navigation there instead.
 */

import { usePathname } from "next/navigation";
import { OfflineBanner } from "./offline-banner";
import { PullToRefresh } from "@/components/pull-to-refresh";

export function DashboardMain({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAssistant = pathname === "/dashboard/ai" || pathname.startsWith("/dashboard/ai/");

  if (isAssistant) {
    return (
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <OfflineBanner />
        <div className="relative min-h-0 flex-1">{children}</div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <OfflineBanner />
      <PullToRefresh className="relative flex-1 overflow-y-auto overscroll-y-contain p-2 pb-[calc(var(--app-bottom-nav)+2rem)] md:p-4 md:pb-4">
        {children}
      </PullToRefresh>
    </div>
  );
}
