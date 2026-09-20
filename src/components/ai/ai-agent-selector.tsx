"use client";

/**
 * The composer's custom-agent picker (Phase I) — the counterpart to the task
 * lens, but for *which business-defined agent* runs the next turns. Each entry
 * is a `CustomAgent` a manager created in `/ai/agents`; picking one sends its
 * id with every dashboard turn, so the backend runs the turn under that
 * agent's own instructions and tool/action allowlist. «دستیار کامل» clears the
 * pick and falls back to the full assistant (or, inside a project, its pinned
 * default agent — the backend resolves that when no request-level agent is
 * named).
 *
 * Dashboard mode only: the floor and wizard surfaces are their own realms and
 * never run as a custom agent, matching the chat route's own scope. The list
 * is fetched once on mount from the same `/api/ai/agents` the management UI
 * uses; while it loads the trigger reserves its shape with a small skeleton so
 * the composer never jumps.
 */
import { useEffect, useState } from "react";
import { BotIcon, ChevronsUpDownIcon, SparklesIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { CustomAgent } from "@/lib/ai-custom-agents";
import type { AssistantMode } from "./use-ai-chat";
import { cn } from "@/lib/utils";

interface AiAgentSelectorProps {
  mode: AssistantMode;
  agentId: string | null;
  disabled?: boolean;
  onSelectAgent: (id: string | null) => void;
}

export function AiAgentSelector({
  mode,
  agentId,
  disabled,
  onSelectAgent,
}: AiAgentSelectorProps) {
  const [agents, setAgents] = useState<CustomAgent[] | null>(null);

  // Only dashboard mode runs as a custom agent — don't fetch elsewhere.
  useEffect(() => {
    if (mode !== "dashboard") return;
    let alive = true;
    fetch("/api/ai/agents")
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data: { agents?: CustomAgent[] }) => {
        if (alive) setAgents(Array.isArray(data.agents) ? data.agents : []);
      })
      .catch(() => {
        if (alive) setAgents([]);
      });
    return () => {
      alive = false;
    };
  }, [mode]);

  if (mode !== "dashboard") return null;

  // Loading: reserve the trigger's shape so the composer row never jumps.
  if (agents === null) {
    return <Skeleton className="h-[30px] w-28 rounded-full" />;
  }

  // Only enabled agents are selectable — a disabled one the backend would
  // refuse anyway. If the currently-picked agent was disabled or deleted
  // elsewhere, the trigger falls back to the full-assistant label; the id is
  // still sent and the backend's 404 surfaces it, so the pick is not silently
  // dropped from state here.
  const enabled = agents.filter((agent) => agent.enabled);
  if (enabled.length === 0) return null;

  const current = enabled.find((agent) => agent.id === agentId) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`ایجنت دستیار: ${current ? current.name : "دستیار کامل"}`}
          title={
            current
              ? current.instructions || current.name
              : "دستیار کامل — بدون محدود کردن به یک ایجنت"
          }
          className={cn(
            "flex max-w-44 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-60 outline-none focus-visible:ring focus-visible:ring-ring/50",
            current
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-border/80 bg-background text-foreground/80 hover:bg-muted hover:text-foreground",
          )}
        >
          {current ? (
            <BotIcon className="size-3.5 shrink-0 text-primary" />
          ) : (
            <SparklesIcon className="size-3.5 shrink-0 text-primary" />
          )}
          <span className="truncate">{current ? current.name : "دستیار کامل"}</span>
          <ChevronsUpDownIcon className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-80 p-1.5">
        <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold text-muted-foreground">
          این گفتگو با کدام ایجنت اجرا شود؟
        </p>

        <DropdownMenuItem
          onClick={() => onSelectAgent(null)}
          className={cn(
            "flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2",
            !agentId && "bg-primary/5",
          )}
        >
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <SparklesIcon className="size-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block text-xs font-semibold leading-5 text-foreground">
              دستیار کامل
            </span>
            <span className="block text-[10px] leading-4 text-muted-foreground">
              بدون محدود کردن به یک ایجنت؛ همهٔ ابزارها و کارهای مجاز
            </span>
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator className="my-1" />

        <div className="max-h-72 overflow-y-auto">
          {enabled.map((agent) => (
            <DropdownMenuItem
              key={agent.id}
              onClick={() => onSelectAgent(agent.id)}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2",
                agentId === agent.id && "bg-primary/5",
              )}
            >
              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <BotIcon className="size-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold leading-5 text-foreground">
                  {agent.name}
                </span>
                {agent.instructions ? (
                  <span className="block truncate text-[10px] leading-4 text-muted-foreground">
                    {agent.instructions}
                  </span>
                ) : null}
              </span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
