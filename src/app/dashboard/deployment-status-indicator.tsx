"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { DeploymentProfile } from "@/lib/deployment-mode";
import { LoadingSkeleton } from "./page-chrome";

type RemoteState = { sync?: string; outboundPending?: number };

/** Compact, shared environment indicator; details live in Cloud & Sync. */
export function DeploymentStatusIndicator({ profile }: { profile: DeploymentProfile }) {
  const [remote, setRemote] = useState<RemoteState>({});
  const [loaded, setLoaded] = useState(profile !== "hybrid");
  useEffect(() => {
    if (profile !== "hybrid") return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/connection/status", { cache: "no-store" });
        if (active && response.ok) setRemote(await response.json() as RemoteState);
      } catch { /* local UI remains usable; status stays conservative */ }
      finally { if (active) setLoaded(true); }
    };
    void refresh();
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    return () => { active = false; window.removeEventListener("online", refresh); window.removeEventListener("offline", refresh); };
  }, [profile]);

  if (!loaded) return <LoadingSkeleton className="h-9 w-full rounded-lg" />;
  const pending = remote.outboundPending ?? 0;
  const label = profile === "cloud"
    ? "ابر"
    : profile === "local"
      ? "فقط محلی · اتصال به ابر"
      : remote.sync === "connected"
        ? "سایت محلی · همگام با ابر"
        : `سایت محلی · همگام‌سازی متوقف${pending ? ` · ${pending.toLocaleString("fa-IR")} در انتظار` : ""}`;
  return (
    <Link
      href="/settings/cloud-sync"
      className="flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      title="وضعیت محیط و همگام‌سازی"
    >
      <span className={`size-2 rounded-full ${profile === "hybrid" && remote.sync !== "connected" ? "bg-amber-500 dark:bg-amber-400" : profile === "local" ? "bg-stone-400 dark:bg-stone-500" : "bg-emerald-500 dark:bg-emerald-400"}`} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Link>
  );
}
