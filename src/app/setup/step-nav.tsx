"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { stepsFor } from "./steps";
import { useSetupIndustry } from "./industry-context";
import { Skeleton } from "@/components/ui/skeleton";

interface StateResponse {
  progress?: { steps: Record<string, string>; completedAt: string | null };
  localOnly?: boolean;
}

export function StepNav() {
  const pathname = usePathname();
  const industry = useSetupIndustry();
  const [done, setDone] = useState<Record<string, string>>({});
  const [localOnly, setLocalOnly] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    fetch("/api/setup/state")
      .then((r) => r.json())
      .then((s: StateResponse) => {
        if (cancelled) return;
        if (s.progress) setDone(s.progress.steps);
        setLocalOnly(Boolean(s.localOnly));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  // The backup-destination step only means anything on a standalone install;
  // on a connected one its page steps aside, so don't offer a link that would
  // bounce straight to the next step.
  const steps = stepsFor(industry).filter((s) => s.id !== "backup" || localOnly);

  if (!loaded) {
    return (
      <nav
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="در حال بارگذاری مراحل راه‌اندازی"
        className="space-y-2"
      >
        {[0, 1, 2, 3, 4, 5].map((item) => (
          <Skeleton key={item} aria-hidden="true" className="h-9 w-full rounded-lg" />
        ))}
      </nav>
    );
  }

  return (
    <nav className="space-y-1">
      {steps.map((s, i) => {
        const active = pathname === s.path;
        const isDone = Boolean(done[s.id]);
        return (
          <Link
            key={s.id}
            href={s.path}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
              active
                ? "bg-primary/5 font-semibold text-primary"
                : "text-muted-foreground hover:bg-muted/50"
            }`}
          >
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
                isDone
                  ? "bg-emerald-700 text-white dark:bg-emerald-600"
                  : active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {isDone ? "✓" : toPersianDigits(i + 1)}
            </span>
            <span className="truncate">{s.short}</span>
            {s.optional ? <span className="ms-auto text-[10px] text-muted-foreground">اختیاری</span> : null}
          </Link>
        );
      })}
      <Link
        href="/setup/finish"
        className={`mt-2 flex items-center gap-2 rounded-lg border-t border-border px-3 py-2 pt-3 text-sm ${
          pathname === "/setup/finish" ? "font-semibold text-primary" : "text-muted-foreground hover:bg-muted/50"
        }`}
      >
        پایان راه‌اندازی
      </Link>
    </nav>
  );
}
