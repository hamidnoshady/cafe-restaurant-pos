import * as React from "react";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { type StatusTone } from "./status-badge";

const TONE_TEXT: Record<StatusTone, string> = {
  neutral: "text-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
  info: "text-sky-600 dark:text-sky-400",
  muted: "text-muted-foreground",
};

const TONE_RING: Record<StatusTone, string> = {
  neutral: "ring-foreground/10",
  success: "ring-emerald-500/25 dark:ring-emerald-400/25",
  warning: "ring-amber-500/25 dark:ring-amber-400/25",
  danger: "ring-red-500/25 dark:ring-red-400/25",
  info: "ring-sky-500/25 dark:ring-sky-400/25",
  muted: "ring-foreground/10",
};

/**
 * A single headline figure for the overview/system dashboards. Actionable, not
 * decorative (section 3): when `href` is set the whole card is a link into the
 * relevant section, with an affordance chevron.
 */
export function PlatformStat({
  label,
  value,
  tone = "neutral",
  hint,
  icon,
  href,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: StatusTone;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  href?: string;
  className?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{label}</p>
        {icon ? <span className={cn("shrink-0", TONE_TEXT[tone])} aria-hidden="true">{icon}</span> : null}
      </div>
      <p className={cn("mt-1 text-2xl font-bold tabular-nums", TONE_TEXT[tone])}>{value}</p>
      {hint ? (
        <p className="mt-1 flex items-center gap-1 text-[11px] leading-5 text-muted-foreground">
          {hint}
          {href ? <ChevronLeftIcon className="size-3 opacity-60" aria-hidden="true" /> : null}
        </p>
      ) : null}
    </>
  );

  const base = cn("rounded-xl bg-card p-4 ring-1", TONE_RING[tone], className);

  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          base,
          "block transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {body}
      </Link>
    );
  }
  return <div className={base}>{body}</div>;
}
