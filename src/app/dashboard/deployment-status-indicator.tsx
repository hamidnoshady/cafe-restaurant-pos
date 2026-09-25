"use client";

import Link from "next/link";
import type { DeploymentProfile } from "@/lib/deployment-mode";
import { LoadingSkeleton } from "./page-chrome";
import { useOfflineQueue } from "./offline-queue";

/** Compact consumer of the shell's single connection-state poller. */
export function DeploymentStatusIndicator({ profile }: { profile: DeploymentProfile }) {
  const { serverStatus } = useOfflineQueue();
  if (profile === "hybrid" && !serverStatus) return <LoadingSkeleton className="h-9 w-full rounded-lg" />;
  const pending = serverStatus?.outboundPending ?? 0;
  const label = profile === "cloud"
    ? "ابر"
    : profile === "local"
      ? "فقط محلی · اتصال به ابر"
      : serverStatus?.sync === "connected"
        ? "سایت محلی · همگام با ابر"
        : `سایت محلی · همگام‌سازی متوقف${pending ? ` · ${pending.toLocaleString("fa-IR")} در انتظار` : ""}`;
  return (
    <Link
      href="/settings/cloud-sync"
      className="flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      title="وضعیت محیط و همگام‌سازی"
    >
      <span className={`size-2 rounded-full ${profile === "hybrid" && serverStatus?.sync !== "connected" ? "bg-amber-500 dark:bg-amber-400" : profile === "local" ? "bg-stone-400 dark:bg-stone-500" : "bg-emerald-500 dark:bg-emerald-400"}`} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Link>
  );
}
