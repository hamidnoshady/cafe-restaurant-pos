"use client";

import { ChevronRightIcon, ChevronLeftIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";

/**
 * Pagination for the console's server-backed lists. Two shapes, one component:
 *   - offset/total: shows "page X of Y" with numeric jumps.
 *   - cursor: shows previous/next with no total (for large/streamed lists).
 * Persian digits, RTL — "next" advances toward the inline-start.
 */
export function PlatformPagination({
  page,
  pageSize,
  total,
  onPageChange,
  hasNext,
  hasPrev,
  onNext,
  onPrev,
  className,
}: {
  // Offset mode
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  // Cursor mode
  hasNext?: boolean;
  hasPrev?: boolean;
  onNext?: () => void;
  onPrev?: () => void;
  className?: string;
}) {
  // Offset/total mode
  if (page !== undefined && pageSize !== undefined && total !== undefined && onPageChange) {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (total <= pageSize) return null;
    const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const to = Math.min(page * pageSize, total);
    return (
      <nav
        aria-label="صفحه‌بندی"
        className={cn("mt-4 flex flex-wrap items-center justify-between gap-2", className)}
      >
        <p className="text-xs text-muted-foreground">
          {`${toPersianDigits(from)}–${toPersianDigits(to)} از ${toPersianDigits(total)}`}
        </p>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="صفحهٔ قبل"
          >
            <ChevronRightIcon aria-hidden="true" />
          </Button>
          <span className="px-2 text-xs tabular-nums text-muted-foreground">
            {`${toPersianDigits(page)} / ${toPersianDigits(totalPages)}`}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            aria-label="صفحهٔ بعد"
          >
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
        </div>
      </nav>
    );
  }

  // Cursor mode
  if (onNext || onPrev) {
    return (
      <nav aria-label="صفحه‌بندی" className={cn("mt-4 flex items-center justify-end gap-1", className)}>
        <Button variant="outline" size="sm" onClick={onPrev} disabled={!hasPrev}>
          <ChevronRightIcon aria-hidden="true" />
          قبلی
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={!hasNext}>
          بعدی
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
      </nav>
    );
  }

  return null;
}
