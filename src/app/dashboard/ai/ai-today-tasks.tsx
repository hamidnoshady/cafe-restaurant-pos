"use client";

import { CheckCircle2Icon, ClockIcon, Loader2Icon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { cn } from "@/lib/utils";
import type { AgentTodayTask } from "./ai-agent-cards";

function formatHour(hour: number): string {
  return toPersianDigits(`${String(hour).padStart(2, "0")}:00`);
}

/**
 * Wave 4 (issue #144) hub sidebar: "کارهای خودکار امروز" — today's scheduled
 * agent runs, sorted by hour, with a done/pending badge. `tasks` is `null`
 * while the shared fetch in `AiAgentCards` (same `/api/ai/agents` payload)
 * is still loading, and `[]` once loaded with nothing scheduled today.
 */
export function AiTodayTasks({ tasks }: { tasks: AgentTodayTask[] | null }) {
  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border bg-card">
      <header className="border-b px-3 py-2.5">
        <p className="text-sm font-semibold">کارهای خودکار امروز</p>
      </header>
      <div className="space-y-1.5 p-1.5">
        {tasks === null ? (
          <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" /> در حال خواندن…
          </p>
        ) : tasks.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">امروز کار خودکاری زمان‌بندی نشده است.</p>
        ) : (
          tasks.map((task) => (
            <div
              key={task.agentKey}
              className="flex items-center justify-between gap-2 rounded-xl border bg-background p-2.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-xs font-medium">{task.label}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-[11px] tabular-nums text-muted-foreground" dir="ltr">
                  {formatHour(task.scheduledHour)}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                    task.status === "done"
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                  )}
                >
                  {task.status === "done" ? <CheckCircle2Icon className="size-3" /> : null}
                  {task.status === "done" ? "انجام‌شده" : "در انتظار"}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
