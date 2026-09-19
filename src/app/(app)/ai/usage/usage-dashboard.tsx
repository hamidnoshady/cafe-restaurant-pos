"use client";

/**
 * «مصرف و هزینه» — the AI Usage section's client (Phase I).
 *
 * A read-only view over `/api/ai/usage`: a window switch (۷/۳۰/۹۰ روز), four
 * headline cards (spend, turns, cache hits, current balance/debt), a per-origin
 * breakdown with proportional bars, and a table of the most recent turns. Every
 * number is the wallet's own settlement record — this section computes nothing
 * about money, it only presents what billing already wrote — so it needs no
 * confirm loop and no write path.
 *
 * The balance and any outstanding AI debt are shown here too, because "what is
 * AI costing us" and "can we afford the next turn" are the same question; the
 * debt line is the same backstop the pre-request gate enforces, surfaced rather
 * than hidden.
 */

import { useCallback, useEffect, useState } from "react";
import { WalletIcon } from "lucide-react";
import { api } from "@/app/dashboard/ui";
import { useFeatureLocked } from "@/components/feature-lock";
import {
  cardClass,
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { cn } from "@/lib/utils";
import { formatToman } from "@/lib/money";
import { toPersianDigits } from "@/lib/digits";
import {
  AI_USAGE_WINDOWS,
  cacheHitRate,
  requestTypeLabel,
  type AiUsagePricedBy,
  type AiUsageSummary,
  type AiUsageWindowDays,
} from "@/lib/ai-usage-shared";

const PRICED_BY_LABEL: Record<AiUsagePricedBy, string> = {
  gateway: "هزینهٔ واقعی",
  token_rate: "نرخ توکن",
  free: "رایگان",
};

const PRICED_BY_TONE: Record<AiUsagePricedBy, "positive" | "neutral" | "active"> = {
  gateway: "positive",
  token_rate: "neutral",
  free: "active",
};

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function fa(value: number): string {
  return toPersianDigits(String(value));
}

function percentText(fraction: number): string {
  return `${toPersianDigits(String(Math.round(fraction * 100)))}٪`;
}

export function UsageDashboard() {
  const locked = useFeatureLocked();
  const [windowDays, setWindowDays] = useState<AiUsageWindowDays>(AI_USAGE_WINDOWS[0]);
  const [summary, setSummary] = useState<AiUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(
    async (days: AiUsageWindowDays) => {
      if (locked) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(false);
      const { ok, data } = await api<{ summary?: AiUsageSummary }>(
        `/api/ai/usage?days=${days}`,
      );
      if (ok && data.summary) {
        setSummary(data.summary);
      } else {
        setError(true);
      }
      setLoading(false);
    },
    [locked],
  );

  useEffect(() => {
    void load(windowDays);
  }, [load, windowDays]);

  if (loading) return <LoadingSkeleton rows={5} />;

  if (locked) {
    return (
      <EmptyState>
        دستیار هوشمند برای این کسب‌وکار فعال نیست؛ داده‌ای برای نمایش مصرف وجود ندارد.
      </EmptyState>
    );
  }

  if (error || !summary) {
    return (
      <div className="space-y-3">
        <EmptyState>خواندن گزارش مصرف ممکن نشد.</EmptyState>
        <div className="text-center">
          <button
            type="button"
            onClick={() => void load(windowDays)}
            className="rounded-lg border border-border/80 bg-card px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            تلاش دوباره
          </button>
        </div>
      </div>
    );
  }

  const maxCharged = summary.byType.reduce(
    (max, slice) => Math.max(max, slice.chargedRial),
    0,
  );
  const hitRate = cacheHitRate(summary);
  const marginRial = summary.totalChargedRial - summary.totalProviderCostRial;

  return (
    <div className="mt-4 space-y-4">
      {/* Window switch */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">بازهٔ زمانی:</span>
        {AI_USAGE_WINDOWS.map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => setWindowDays(days)}
            aria-pressed={windowDays === days}
            className={
              windowDays === days
                ? "rounded-full border border-amber-200 bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
                : "rounded-full border border-border/80 bg-card px-3 py-1.5 text-xs font-medium text-foreground/80 hover:bg-muted"
            }
          >
            {toPersianDigits(String(days))} روز
          </button>
        ))}
      </div>

      {/* Headline cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="هزینهٔ این بازه"
          value={formatToman(summary.totalChargedRial)}
          hint={
            marginRial > 0
              ? `از این مقدار، ${formatToman(marginRial)} کارمزد پلتفرم`
              : undefined
          }
        />
        <StatCard label="تعداد درخواست" value={`${fa(summary.totalTurns)} درخواست`} />
        <StatCard
          label="استفاده از حافظهٔ پاسخ"
          value={percentText(hitRate)}
          hint={`${fa(summary.cacheHits)} پاسخ از حافظه`}
        />
        <StatCard
          label="موجودی کیف پول"
          value={formatToman(summary.balanceRial)}
          hint={
            summary.debtRial > 0
              ? `بدهی هوش مصنوعی: ${formatToman(summary.debtRial)}`
              : undefined
          }
          tone={summary.debtRial > 0 ? "warning" : undefined}
        />
      </div>

      {/* Debt warning — the same backstop the pre-request gate enforces. */}
      {summary.debtRial > 0 ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <WalletIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            این کسب‌وکار {formatToman(summary.debtRial)} بدهی هوش مصنوعی دارد؛ تا شارژ
            کیف پول و تسویهٔ آن، درخواست تازهٔ هوش مصنوعی انجام نمی‌شود.
          </p>
        </div>
      ) : null}

      {/* Breakdown by origin */}
      <SectionCard
        title="مصرف بر اساس نوع کار"
        description="هزینهٔ هوش مصنوعی به تفکیک این‌که صرف چه کاری شده است."
      >
        {summary.byType.length === 0 ? (
          <EmptyState>در این بازه هزینه‌ای ثبت نشده است.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {summary.byType.map((slice) => (
              <li key={slice.requestType}>
                <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium text-foreground">{slice.label}</span>
                  <span className="text-muted-foreground">
                    {formatToman(slice.chargedRial)}
                    <span className="ms-2 text-xs">
                      ({fa(slice.turns)} درخواست)
                    </span>
                  </span>
                </div>
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-muted"
                  role="presentation"
                >
                  <div
                    className="h-full rounded-full bg-amber-400 dark:bg-amber-500"
                    style={{
                      width:
                        maxCharged > 0
                          ? `${Math.max(3, (slice.chargedRial / maxCharged) * 100)}%`
                          : "0%",
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* Recent turns */}
      <SectionCard
        title="آخرین درخواست‌ها"
        description="تازه‌ترین درخواست‌های هوش مصنوعی که کیف پول برای آن‌ها هزینه ثبت کرده است."
        flush
      >
        {summary.recentTurns.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>در این بازه درخواستی ثبت نشده است.</EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border/80 text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-start font-medium">نوع کار</th>
                  <th className="px-4 py-2 text-start font-medium">مدل</th>
                  <th className="px-4 py-2 text-start font-medium">توکن (ورودی/خروجی)</th>
                  <th className="px-4 py-2 text-start font-medium">هزینه</th>
                  <th className="px-4 py-2 text-start font-medium">قیمت‌گذاری</th>
                  <th className="px-4 py-2 text-start font-medium">زمان</th>
                </tr>
              </thead>
              <tbody>
                {summary.recentTurns.map((turn) => (
                  <tr
                    key={turn.id}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-foreground">
                        {requestTypeLabel(turn.requestType)}
                      </span>
                      {turn.cacheHit ? (
                        <span className="ms-2 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                          از حافظه
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {turn.model ? (
                        <span dir="ltr" className="font-mono text-xs">
                          {turn.model}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {turn.inputTokens != null || turn.outputTokens != null
                        ? `${fa(turn.inputTokens ?? 0)} / ${fa(turn.outputTokens ?? 0)}`
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-foreground">
                      {formatToman(turn.chargedRial)}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge tone={PRICED_BY_TONE[turn.pricedBy]}>
                        {PRICED_BY_LABEL[turn.pricedBy]}
                      </StatusBadge>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {formatDateTime(turn.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warning";
}) {
  return (
    <div className={cn(cardClass, "p-4")}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          tone === "warning"
            ? "mt-1 text-lg font-bold text-amber-600 dark:text-amber-400"
            : "mt-1 text-lg font-bold text-foreground"
        }
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
