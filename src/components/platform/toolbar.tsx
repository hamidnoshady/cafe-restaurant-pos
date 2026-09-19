"use client";

import * as React from "react";
import { SearchIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";

/**
 * The shared toolbar/filter primitives for every operational list. One search
 * box, one filter bar, one refresh button, one result count — so businesses,
 * audit, payments, support and the rest all filter the same way (section 6).
 */

/** A debounced-friendly search box. The caller owns the value + debounce. */
export function PlatformSearch({
  value,
  onChange,
  placeholder = "جستجو…",
  className,
  ariaLabel = "جستجو",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={cn("relative min-w-0 flex-1 sm:max-w-xs", className)}>
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute inset-inline-start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        inputMode="search"
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="ps-9"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="پاک کردن جستجو"
          className="absolute inset-inline-end-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * A responsive filter bar: search + filter controls on one wrapping row, with
 * an optional reset button that appears only when filters are active. On mobile
 * it stacks; on desktop it flows inline.
 */
export function PlatformFilterBar({
  children,
  onReset,
  isFiltered,
  resultCount,
  totalCount,
  className,
}: {
  children: React.ReactNode;
  onReset?: () => void;
  isFiltered?: boolean;
  resultCount?: number;
  totalCount?: number;
  className?: string;
}) {
  return (
    <div className={cn("mb-4 space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {(isFiltered && onReset) || resultCount !== undefined ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {resultCount !== undefined ? (
            <p className="text-xs text-muted-foreground">
              {totalCount !== undefined && totalCount !== resultCount
                ? `${toPersianDigits(resultCount)} از ${toPersianDigits(totalCount)} نتیجه`
                : `${toPersianDigits(resultCount)} نتیجه`}
            </p>
          ) : (
            <span />
          )}
          {isFiltered && onReset ? (
            <Button variant="ghost" size="sm" onClick={onReset}>
              <XIcon aria-hidden="true" />
              حذف فیلترها
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A refresh button that spins while a background refresh is in flight. */
export function PlatformRefreshButton({
  onClick,
  refreshing,
  className,
  label = "تازه‌سازی",
}: {
  onClick: () => void;
  refreshing?: boolean;
  className?: string;
  label?: string;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={refreshing}
      aria-label={label}
      aria-busy={refreshing || undefined}
      title={label}
      className={className}
    >
      <RefreshCwIcon aria-hidden="true" />
      <span className="hidden sm:inline">{refreshing ? "در حال تازه‌سازی…" : label}</span>
    </Button>
  );
}

/** A sticky toolbar wrapper for long operational workflows (section 30). */
export function PlatformToolbar({
  children,
  className,
  sticky = false,
}: {
  children: React.ReactNode;
  className?: string;
  sticky?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2",
        sticky && "sticky top-0 z-10 -mx-3 bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-4 sm:px-4",
        className,
      )}
    >
      {children}
    </div>
  );
}
