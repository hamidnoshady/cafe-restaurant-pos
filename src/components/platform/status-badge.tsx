import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The console's status vocabulary in one place. Status must never rely on
 * colour alone (section 31), so every badge pairs a colour with a Persian
 * label. A `tone` maps to a fixed colour set shared across every section so
 * "green means healthy" is learned once.
 */
export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info" | "muted";

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "border-border bg-muted/50 text-foreground",
  success: "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  warning: "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  danger: "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300",
  info: "border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-300",
  muted: "border-border/60 bg-transparent text-muted-foreground",
};

const DOT_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-foreground/40",
  success: "bg-emerald-500 dark:bg-emerald-400",
  warning: "bg-amber-500 dark:bg-amber-400",
  danger: "bg-red-500 dark:bg-red-400",
  info: "bg-sky-500 dark:bg-sky-400",
  muted: "bg-muted-foreground/50",
};

export function PlatformStatusBadge({
  label,
  tone = "neutral",
  dot = false,
  className,
  title,
}: {
  label: React.ReactNode;
  tone?: StatusTone;
  /** Prefix a coloured dot — useful in dense tables where the pill is small. */
  dot?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT_CLASSES[tone])} /> : null}
      {label}
    </span>
  );
}

/** Business lifecycle → labelled, coloured badge (active/suspended/archived). */
const BUSINESS_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  active: { label: "فعال", tone: "success" },
  suspended: { label: "معلق", tone: "warning" },
  archived: { label: "بایگانی", tone: "muted" },
};

export function BusinessStatusBadge({ status, dot }: { status: string; dot?: boolean }) {
  const s = BUSINESS_STATUS[status] ?? { label: status, tone: "neutral" as StatusTone };
  return <PlatformStatusBadge label={s.label} tone={s.tone} dot={dot} />;
}
