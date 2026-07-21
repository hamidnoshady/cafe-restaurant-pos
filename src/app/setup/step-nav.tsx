"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { STEPS } from "./steps";

interface StateResponse {
  progress?: { steps: Record<string, string>; completedAt: string | null };
}

export function StepNav() {
  const pathname = usePathname();
  const [done, setDone] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/setup/state")
      .then((r) => r.json())
      .then((s: StateResponse) => {
        if (!cancelled && s.progress) setDone(s.progress.steps);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return (
    <nav className="space-y-1">
      {STEPS.map((s, i) => {
        const active = pathname === s.path;
        const isDone = Boolean(done[s.id]);
        return (
          <Link
            key={s.id}
            href={s.path}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
              active
                ? "bg-amber-50 font-semibold text-amber-800"
                : "text-stone-600 hover:bg-stone-50"
            }`}
          >
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
                isDone
                  ? "bg-emerald-500 text-white"
                  : active
                    ? "bg-amber-600 text-white"
                    : "bg-stone-200 text-stone-600"
              }`}
            >
              {isDone ? "✓" : toPersianDigits(i + 1)}
            </span>
            <span className="truncate">{s.short}</span>
            {s.optional ? <span className="ms-auto text-[10px] text-stone-400">اختیاری</span> : null}
          </Link>
        );
      })}
      <Link
        href="/setup/finish"
        className={`mt-2 flex items-center gap-2 rounded-lg border-t border-stone-100 px-3 py-2 pt-3 text-sm ${
          pathname === "/setup/finish" ? "font-semibold text-amber-800" : "text-stone-600 hover:bg-stone-50"
        }`}
      >
        پایان راه‌اندازی
      </Link>
    </nav>
  );
}
