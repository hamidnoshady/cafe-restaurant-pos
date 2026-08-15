"use client";

import { useEffect, useState } from "react";
import { FileBarChart2Icon, HandCoinsIcon, Loader2Icon, ScaleIcon, TrendingUpIcon, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { useFeatureLocked } from "@/components/feature-lock";
import { AI_AGENT_DEFINITIONS, type AiAgentKey } from "@/lib/ai-agents";

interface AgentOverviewEntry {
  agentKey: AiAgentKey;
  enabled: boolean;
  scheduleHour: number;
  status: "active" | "scheduled" | "inactive";
  lastRunAt: string | null;
  lastRunStatus: "completed" | "skipped" | "failed" | null;
}

export interface AgentTodayTask {
  agentKey: AiAgentKey;
  label: string;
  scheduledHour: number;
  status: "done" | "pending";
}

const AGENT_ICONS: Record<AiAgentKey, LucideIcon> = {
  financial_report_builder: FileBarChart2Icon,
  sales_analyzer: TrendingUpIcon,
  receivables_follow_up: HandCoinsIcon,
  reconciliation_assistant: ScaleIcon,
};

const STATUS_LABEL: Record<AgentOverviewEntry["status"], string> = {
  active: "فعال",
  scheduled: "زمان‌بندی‌شده",
  inactive: "غیرفعال",
};

const STATUS_CLASS: Record<AgentOverviewEntry["status"], string> = {
  active: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  scheduled: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  inactive: "bg-muted text-muted-foreground",
};

/** Wave 3 (issue #143) hub sidebar: independent per-agent status cards + toggles, replacing the single ai/proactive switch's all-or-nothing control. */
export function AiAgentCards({ onTodayTasksChange }: { onTodayTasksChange?: (tasks: AgentTodayTask[]) => void }) {
  const [agents, setAgents] = useState<AgentOverviewEntry[] | null>(null);
  const [savingKey, setSavingKey] = useState<AiAgentKey | null>(null);
  const locked = useFeatureLocked();

  async function load() {
    try {
      const response = await fetch("/api/ai/agents");
      const body = (await response.json().catch(() => ({}))) as {
        agents?: AgentOverviewEntry[];
        todayTasks?: AgentTodayTask[];
        error?: string;
      };
      if (!response.ok || !body.agents) throw new Error(body.error ?? "خواندن ایجنت‌ها ممکن نشد.");
      setAgents(body.agents);
      onTodayTasksChange?.(body.todayTasks ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "خواندن ایجنت‌ها ممکن نشد.");
    }
  }

  useEffect(() => {
    if (locked) {
      setAgents([]);
      onTodayTasksChange?.([]);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  async function toggle(agentKey: AiAgentKey, enabled: boolean) {
    if (savingKey) return;
    setSavingKey(agentKey);
    try {
      const response = await fetch("/api/ai/agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentKey, enabled }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        agents?: AgentOverviewEntry[];
        todayTasks?: AgentTodayTask[];
        error?: string;
      };
      if (!response.ok || !body.agents) throw new Error(body.error ?? "ذخیرهٔ وضعیت ایجنت ممکن نشد.");
      setAgents(body.agents);
      onTodayTasksChange?.(body.todayTasks ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ذخیرهٔ وضعیت ایجنت ممکن نشد.");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border bg-card">
      <header className="border-b px-3 py-2.5">
        <p className="text-sm font-semibold">ایجنت‌های فعال</p>
      </header>
      <div className="space-y-1.5 p-1.5">
        {agents === null ? (
          <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" /> در حال خواندن…
          </p>
        ) : (
          AI_AGENT_DEFINITIONS.map((definition) => {
            const entry = agents.find((a) => a.agentKey === definition.key);
            const Icon = AGENT_ICONS[definition.key];
            const status = entry?.status ?? "inactive";
            return (
              <div key={definition.key} className="rounded-xl border bg-background p-2.5">
                <div className="flex items-start gap-2">
                  <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-xs font-semibold">{definition.title}</p>
                      <Switch
                        size="sm"
                        checked={entry?.enabled ?? false}
                        disabled={!entry || savingKey === definition.key}
                        onCheckedChange={(checked) => void toggle(definition.key, checked)}
                        aria-label={`فعال/غیرفعال‌سازی ${definition.title}`}
                      />
                    </div>
                    <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{definition.description}</p>
                    <span
                      className={cn(
                        "mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium",
                        STATUS_CLASS[status],
                      )}
                    >
                      {STATUS_LABEL[status]}
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
