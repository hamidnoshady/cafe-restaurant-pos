import * as React from "react";
import { AlertTriangleIcon, InboxIcon, SearchXIcon, RefreshCwIcon, LockIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The console's shared loading / empty / error states (sections 33 + 4).
 * Every list distinguishes: initial loading, refreshing (handled by the caller
 * keeping data visible), empty, filtered-empty, permission denied, server error
 * and network error — all rendered here so they look and behave identically.
 */

export function PlatformLoadingState({
  rows = 5,
  label = "در حال بارگذاری…",
  className,
}: {
  rows?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      className={cn("space-y-2", className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function PlatformEmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card px-4 py-12 text-center",
        className,
      )}
    >
      <span className="mb-1 text-muted-foreground" aria-hidden="true">
        {icon ?? <InboxIcon className="size-8" />}
      </span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-sm text-xs leading-6 text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** The "your filters matched nothing" variant, with a reset shortcut. */
export function PlatformFilteredEmptyState({
  onReset,
  className,
}: {
  onReset?: () => void;
  className?: string;
}) {
  return (
    <PlatformEmptyState
      className={className}
      icon={<SearchXIcon className="size-8" />}
      title="هیچ نتیجه‌ای با این فیلترها پیدا نشد."
      description="عبارت جستجو یا یکی از فیلترها را تغییر دهید."
      action={
        onReset ? (
          <Button variant="outline" size="sm" onClick={onReset}>
            حذف فیلترها
          </Button>
        ) : undefined
      }
    />
  );
}

export function PlatformErrorState({
  message,
  status,
  onRetry,
  className,
}: {
  /** Operator-facing Persian text (already translated). */
  message?: string | null;
  /** HTTP status, to distinguish a permission wall from a generic failure. */
  status?: number | null;
  onRetry?: () => void;
  className?: string;
}) {
  const forbidden = status === 403;
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-10 text-center",
        className,
      )}
    >
      <span className="mb-1 text-destructive" aria-hidden="true">
        {forbidden ? <LockIcon className="size-8" /> : <AlertTriangleIcon className="size-8" />}
      </span>
      <p className="text-sm font-medium text-foreground">
        {forbidden ? "دسترسی لازم را ندارید" : "بارگذاری ناموفق بود"}
      </p>
      <p className="max-w-sm text-xs leading-6 text-muted-foreground">
        {message ?? "خطای غیرمنتظره. دوباره تلاش کنید."}
      </p>
      {onRetry && !forbidden ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-2">
          <RefreshCwIcon aria-hidden="true" />
          تلاش دوباره
        </Button>
      ) : null}
    </div>
  );
}

/** An inline (non-blocking) error banner for form/mutation failures. */
export function PlatformInlineError({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className={cn(
        "rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive",
        className,
      )}
    >
      {children}
    </div>
  );
}
