"use client";

/**
 * Phase 36d — the CRM's audiences, inside the Growth app.
 *
 * The segment builder lives in the CRM, where the customer record lives. This
 * panel is the other half of that handoff: pick a saved segment, pick a
 * channel, and see who a campaign would actually reach *before* sending
 * anything.
 *
 * Three numbers, deliberately, rather than one:
 *
 *   - «مطابق قاعده» — everyone the rules matched.
 *   - «قابل ارسال»  — who consented on this channel.
 *   - «بدون اجازه»  — the difference.
 *
 * Showing only the last number would look like the segment was smaller than it
 * is; showing only the first would imply a reach the business does not legally
 * have. The gap between them is the interesting part, and the reason consent is
 * resolved server-side in the CRM rather than filtered in this component.
 *
 * A fourth, «بدون شماره/ایمیل», separates "consented but we have no address"
 * from "refused" — the first is a data-quality problem an owner can fix, the
 * second is a decision they must respect.
 */

import { useCallback, useEffect, useState } from "react";
import { formatPersianNumber } from "@/lib/digits";
import { CAMPAIGN_CHANNELS, CAMPAIGN_CHANNEL_LABELS, type CampaignChannel } from "@/lib/campaign-channels";
import { cardClass, EmptyState, LoadingSkeleton, SectionCard } from "../page-chrome";
import { api, ErrorBox, errorMessage, inputClass, SecondaryButton } from "../ui";
import { crmSectionHref } from "../crm/crm-routes";

interface SegmentOption {
  id: string;
  name: string;
  memberCount: number;
}

interface Audience {
  channel: CampaignChannel;
  matched: number;
  reachable: number;
  excludedByConsent: number;
  missingContact: number;
  truncated: boolean;
}

export function CampaignAudiencePanel() {
  const [segments, setSegments] = useState<SegmentOption[] | null>(null);
  const [segmentId, setSegmentId] = useState("");
  const [channel, setChannel] = useState<CampaignChannel>("sms");
  const [audience, setAudience] = useState<Audience | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<{ segments: SegmentOption[] }>("/api/crm/segments")
      .then(({ ok, data }) => {
        if (cancelled) return;
        // A business with the CRM module off, or simply no segments yet, is not
        // an error state — it is an empty state with a way forward.
        setSegments(ok && data ? data.segments : []);
      })
      .catch(() => {
        if (!cancelled) setSegments([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const check = useCallback(async () => {
    if (!segmentId) return;
    setBusy(true);
    setAudience(null);
    setError(null);
    try {
      const { ok, data } = await api<{ audience?: Audience; error?: string }>(
        "/api/growth/campaign-audience",
        { method: "POST", body: JSON.stringify({ segmentId, channel }) },
      );
      if (!ok || !data?.audience) {
        setError(errorMessage(data?.error));
        return;
      }
      setAudience(data.audience);
    } catch {
      setError("محاسبهٔ مخاطبان ممکن نشد.");
    } finally {
      setBusy(false);
    }
  }, [segmentId, channel]);

  // Re-resolve when the channel changes, so the numbers can never describe a
  // channel other than the one selected.
  useEffect(() => {
    setAudience(null);
  }, [channel, segmentId]);

  return (
    <SectionCard
      title="مخاطبان کمپین"
      description="یک بخش از مشتریان را انتخاب کنید تا ببینید کمپین به چند نفر می‌رسد"
    >
      <ErrorBox>{error}</ErrorBox>

      {segments === null ? (
        <LoadingSkeleton rows={3} label="در حال بارگذاری بخش‌های مشتریان" />
      ) : segments.length === 0 ? (
        <EmptyState>
          هنوز بخشی از مشتریان تعریف نشده است.{" "}
          <a className="font-semibold text-teal-700 dark:text-teal-300 underline-offset-4 hover:underline" href={crmSectionHref("segments")}>
            ساخت بخش در CRM
          </a>
        </EmptyState>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted-foreground">بخش مشتریان</span>
              <select
                className={inputClass}
                value={segmentId}
                onChange={(event) => setSegmentId(event.target.value)}
              >
                <option value="">انتخاب کنید…</option>
                {(segments ?? []).map((segment) => (
                  <option key={segment.id} value={segment.id}>
                    {segment.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted-foreground">کانال ارسال</span>
              <select
                className={inputClass}
                value={channel}
                onChange={(event) => setChannel(event.target.value as CampaignChannel)}
              >
                {CAMPAIGN_CHANNELS.map((value) => (
                  <option key={value} value={value}>
                    {CAMPAIGN_CHANNEL_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <SecondaryButton onClick={() => void check()} disabled={!segmentId || busy}>
            {busy ? "در حال محاسبه…" : "محاسبهٔ مخاطبان"}
          </SecondaryButton>

          {busy ? (
            <LoadingSkeleton rows={3} compact label="در حال محاسبه مخاطبان کمپین" />
          ) : audience ? (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                <Figure label="مطابق قاعده" value={audience.matched} />
                <Figure label={`قابل ارسال (${CAMPAIGN_CHANNEL_LABELS[audience.channel]})`} value={audience.reachable} tone="positive" />
                <Figure label="بدون اجازه" value={audience.excludedByConsent} tone="muted" />
              </div>
              {audience.missingContact > 0 ? (
                <p className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                  {formatPersianNumber(audience.missingContact)} نفر اجازه داده‌اند اما شماره یا ایمیل ثبت‌شده ندارند.
                </p>
              ) : null}
              {audience.excludedByConsent > 0 ? (
                <p className="text-xs text-muted-foreground">
                  اختلاف این دو عدد، مشتریانی است که اجازهٔ دریافت{" "}
                  {CAMPAIGN_CHANNEL_LABELS[audience.channel]} نداده‌اند و در ارسال حذف می‌شوند.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

function Figure({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "positive" | "muted";
}) {
  const toneClass =
    tone === "positive"
      ? "text-teal-700 dark:text-teal-300"
      : tone === "muted"
        ? "text-muted-foreground"
        : "text-foreground";
  return (
    <div className={`${cardClass} p-3`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-bold ${toneClass}`}>{formatPersianNumber(value)}</p>
    </div>
  );
}
