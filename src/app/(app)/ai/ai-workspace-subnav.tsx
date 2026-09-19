"use client";

/**
 * The AI Workspace's shared section strip (Phase I).
 *
 * A single horizontal, scrollable row of section links drawn on every
 * management page of the workspace (Coworkers, Automations, Activity) so the
 * sections read as one product rather than three disconnected pages. It reads
 * the framework-free registry (`ai-workspace-nav.ts`) for its labels, routes
 * and active-state rule, and maps the registry's named icons back to the real
 * lucide components here — the one place React is allowed to meet that list.
 *
 * The chat section links back to `/ai`, the pinned-composer surface; the strip
 * itself is never rendered there (the chat has its own rail), only on the
 * scrolling management pages.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ActivityIcon,
  BotIcon,
  MessagesSquareIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AI_WORKSPACE_SECTIONS,
  activeAiWorkspaceSection,
  type AiWorkspaceIconName,
} from "./ai-workspace-nav";

const ICONS: Record<AiWorkspaceIconName, LucideIcon> = {
  chat: MessagesSquareIcon,
  coworkers: BotIcon,
  automations: ZapIcon,
  activity: ActivityIcon,
};

export function AiWorkspaceSubnav() {
  const pathname = usePathname();
  const active = activeAiWorkspaceSection(pathname);

  return (
    <nav
      aria-label="بخش‌های دستیار هوشمند"
      className="-mx-2 flex gap-2 overflow-x-auto px-2 pb-1 md:mx-0 md:px-0"
    >
      {AI_WORKSPACE_SECTIONS.map((section) => {
        const Icon = ICONS[section.icon];
        const isActive = active === section.key;
        return (
          <Link
            key={section.key}
            href={section.href}
            aria-current={isActive ? "page" : undefined}
            title={section.description}
            className={cn(
              "flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45",
              isActive
                ? "border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
                : "border-border/80 bg-card text-foreground/80 hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="whitespace-nowrap">{section.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
