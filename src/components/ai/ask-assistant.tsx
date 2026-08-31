"use client";

/**
 * Phase 35 Wave 2 — the thin "ask the assistant" link.
 *
 * Mounted in a page's `PageHeader` actions. It carries the page's context to
 * the workspace chat home (`/dashboard`) as a `?ctx=` param, where the hub
 * prefills the composer with it (see ai-chat-hub.tsx). It is deliberately a
 * plain link, not the floating bubble: with the workspace shell on, the bubble
 * is gone from dashboard pages, and a page that wants assistant help offers this
 * instead, next to its own controls.
 */
import Link from "next/link";
import { SparklesIcon } from "lucide-react";

export function AskAssistant({
  context,
  app,
  label = "از دستیار بپرس",
}: {
  /** Pre-filled prompt carried to the chat home. */
  context: string;
  /** Optional app context (e.g. "growth") carried as `?app=`. */
  app?: string;
  label?: string;
}) {
  const params = new URLSearchParams();
  if (context) params.set("ctx", context);
  if (app) params.set("app", app);
  const href = `/dashboard${params.toString() ? `?${params.toString()}` : ""}`;

  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-amber-800 dark:hover:text-amber-300"
    >
      <SparklesIcon className="size-4 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </Link>
  );
}
