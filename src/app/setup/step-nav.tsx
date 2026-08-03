"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { STEPS } from "./steps";

interface StateResponse {
  progress?: { steps: Record<string, string>; completedAt: string | null };
  localOnly?: boolean;
}

export function StepNav() {
  const pathname = usePathname();
  const [done, setDone] = useState<Record<string, string>>({});
  const [localOnly, setLocalOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/setup/state")
      .then((r) => r.json())
      .then((s: StateResponse) => {
        if (cancelled) return;
        if (s.progress) setDone(s.progress.steps);
        setLocalOnly(Boolean(s.localOnly));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  // The backup-destination step only means anything on a standalone install;
  // on a connected one its page steps aside, so don't offer a link that would
  // bounce straight to the next step.
  const steps = STEPS.filter((s) => s.id !== "backup" || localOnly);

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
