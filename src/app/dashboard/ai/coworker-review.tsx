"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Phase 32 — «بازبینی حساب‌ها» on demand.
 *
 * Note what this panel does NOT have: a "fix it" button. Every finding names
 * the screen that fixes it and says what to do there, because choosing the
 * correcting entry is the accountant's call — see accounting-review.ts.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useFeatureLocked } from "@/components/feature-lock";
import {
  ACCOUNTING_REVIEW_SEVERITY_LABELS,
  summarizeFindings,
  type AccountingFinding,
} from "@/lib/accounting-review";
import { toPersianDigits } from "@/lib/digits";
import { EmptyState, SectionCard, StatusBadge } from "../page-chrome";
import { SEVERITY_TONE } from "./coworker-types";

export function CoworkerReview() {
  const locked = useFeatureLocked();
  const [findings, setFindings] = useState<AccountingFinding[] | null>(null);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/ai/coworker/review");
      const body = (await response.json().catch(() => ({}))) as {
        findings?: AccountingFinding[];
        unavailableChecks?: string[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "بازبینی حساب‌ها ممکن نشد.");
      setFindings(body.findings ?? []);
      setUnavailable(body.unavailableChecks ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "بازبینی حساب‌ها ممکن نشد.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!locked) void load();
  }, [load, locked]);

  return (
    <SectionCard
      title="بازبینی حساب‌ها"
      description={
        findings === null
          ? "دفترها را بررسی می‌کند و اشکال‌های واقعی را با پیشنهاد اصلاح فهرست می‌کند."
          : summarizeFindings(findings, unavailable)
      }
      actions={
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading || locked}>
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          {loading ? "در حال بازبینی…" : "بازبینی دوباره"}
        </Button>
      }
      flush
    >
      {/* A check that could not run is said out loud: "no findings" from a
          review that only managed nine of its twelve checks would read as
          clean books, which is the one thing an audit tool must never imply. */}
      {unavailable.length > 0 ? (
        <p className="border-b border-border/80 bg-amber-50 dark:bg-amber-500/15 px-4 py-3 text-xs leading-5 text-amber-900 dark:text-amber-200 sm:px-5">
          {toPersianDigits(unavailable.length)} بررسی در این نوبت انجام نشد، پس این فهرست کامل نیست.
        </p>
      ) : null}
      {loading && findings === null ? (
        <div className="p-4 sm:p-5"><LoadingSkeleton rows={4} label="در حال بررسی دفترها" /></div>
      ) : findings === null || findings.length === 0 ? (
        <div className="p-4 sm:p-5">
          <EmptyState>{summarizeFindings(findings ?? [], unavailable)}</EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-border/80">
          {findings.map((finding) => (
            <li key={finding.code} className="px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">{finding.title}</span>
                <div className="flex items-center gap-2">
                  <StatusBadge tone="neutral">{toPersianDigits(finding.count)} مورد</StatusBadge>
                  <StatusBadge tone={SEVERITY_TONE[finding.severity]}>
                    {ACCOUNTING_REVIEW_SEVERITY_LABELS[finding.severity]}
                  </StatusBadge>
                </div>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{finding.detail}</p>
              <p className="mt-2 text-xs leading-5 text-foreground/80">{finding.suggestion}</p>
              {finding.samples.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {finding.samples.map((sample, index) => (
                    <li key={index} className="text-xs text-muted-foreground">
                      • {sample.label}
                    </li>
                  ))}
                </ul>
              ) : null}
              {finding.href ? (
                <Link
                  href={finding.href}
                  className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
                >
                  رفتن به همان صفحه ←
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
