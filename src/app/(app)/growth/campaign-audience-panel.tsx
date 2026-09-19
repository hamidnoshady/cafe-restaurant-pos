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
 *
 * ## Why the numbers are tied to a request id
 *
 * Changing the channel changes the answer, and the two requests can come back
 * out of order: an SMS result arriving after an email result would leave email
 * selected above SMS figures, which is the one thing this panel exists to
 * prevent. Every resolve carries a sequence number and only the newest is
 * allowed to write state — the same reason the panel also clears the figures
 * the moment the selection changes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatPersianNumber } from "@/lib/digits";
import { CAMPAIGN_CHANNELS, CAMPAIGN_CHANNEL_LABELS, type CampaignChannel } from "@/lib/campaign-channels";
import { cardClass, EmptyState, LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, inputClass, SecondaryButton } from "@/app/dashboard/ui";
import { crmSectionHref } from "@/app/(app)/crm/crm-routes";

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
  const [segmentsFailed, setSegmentsFailed] = useState(false);
  const [segmentId, setSegmentId] = useState("");
  const [channel, setChannel] = useState<CampaignChannel>("sms");
  const [audience, setAudience] = useState<Audience | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Monotonic id of the newest resolve; older replies are dropped. */
  const requestRef = useRef(0);

  const loadSegments = useCallback(async () => {
    setSegments(null);
    setSegmentsFailed(false);
    const { ok, status, data } = await api<{ segments: SegmentOption[] }>("/api/crm/segments");
    // No segments yet — or the CRM module switched off (403) — is an empty
    // state with a way forward, not an error. A server or network failure is a
    // real error and must not masquerade as «هنوز بخشی تعریف نشده».
    if (ok) {
      setSegments(data?.segments ?? []);
      return;
    }
    if (status === 403 || status === 404) {
      setSegments([]);
      return;
    }
    setSegments([]);
    setSegmentsFailed(true);
  }, []);

  useEffect(() => {
    void loadSegments();
  }, [loadSegments]);

  const check = useCallback(async () => {
    if (!segmentId) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;

    setBusy(true);
    setAudience(null);
    setError(null);

    const { ok, data } = await api<{ audience?: Audience; error?: string }>(
      "/api/growth/campaign-audience",
      { method: "POST", body: JSON.stringify({ segmentId, channel }) },
    );

    // A superseded request must not write anything: its answer describes a
    // channel or segment the operator has already moved on from.
    if (requestRef.current !== requestId) return;

    setBusy(false);
    if (!ok || !data?.audience) {
      setError(errorMessage(data?.error));
      return;
    }
    setAudience(data.audience);
  }, [segmentId, channel]);

  // Clear the figures whenever the question changes, so the numbers on screen
  // can never describe a channel or segment other than the selected one. The
  // bumped request id also invalidates any resolve still in flight.
  useEffect(() => {
    requestRef.current += 1;
    setAudience(null);
    setError(null);
    setBusy(false);
  }, [channel, segmentId]);

  return (
    <SectionCard
      title="مخاطبان کمپین"
      description="یک بخش از مشتریان را انتخاب کنید تا ببینید کمپین به چند نفر می‌رسد"
    >
      <ErrorBox>{error}</ErrorBox>

      {segments === null ? (
        <LoadingSkeleton rows={3} label="در حال بارگذاری بخش‌های مشتریان" />
      ) : segmentsFailed ? (
        <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          <p>خواندن بخش‌های مشتریان ممکن نشد.</p>
          <div className="mt-3 flex justify-center">
            <SecondaryButton onClick={() => void loadSegments()}>تلاش دوباره</SecondaryButton>
          </div>
        </div>
      ) : segments.length === 0 ? (
        <EmptyState>
          هنوز بخشی از مشتریان تعریف نشده است.{" "}
          <Link
            className="font-semibold text-teal-700 dark:text-teal-300 underline-offset-4 hover:underline"
            href={crmSectionHref("segments")}
          >
            ساخت بخش در CRM
          </Link>
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
                {segments.map((segment) => (
                  <option key={segment.id} value={segment.id}>
                    {segment.name}
                    {/* The saved count, so the list is choosable without
                        resolving each segment one at a time. */}
                    {Number.isFinite(segment.memberCount)
                      ? ` (${formatPersianNumber(segment.memberCount)} نفر)`
                      : ""}
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
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-3">
                <Figure label="مطابق قاعده" value={audience.matched} />
                {/*
                  Consent alone does not make someone reachable: a customer who
                  agreed to SMS but has no phone number on file cannot be sent
                  to. Subtracting `missingContact` keeps this figure equal to
                  the number of messages that will actually go out, which is
                  what an operator reads it as. The gap itself is named on the
                  amber line below so it stays actionable rather than hidden.
                */}
                <Figure
                  label={`قابل ارسال (${CAMPAIGN_CHANNEL_LABELS[audience.channel]})`}
                  value={Math.max(0, audience.reachable - audience.missingContact)}
                  tone="positive"
                />
                <Figure label="بدون اجازه" value={audience.excludedByConsent} tone="muted" />
              </div>
              {audience.missingContact > 0 ? (
                <p className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-200">
                  {formatPersianNumber(audience.missingContact)}
                  {/* Beyond the resolve cap the address check only saw the
                      first page of members, so the number is a floor. Saying
                      «حداقل» is the honest form of that. */}
                  {audience.truncated ? " نفر (حداقل)" : " نفر"} اجازه داده‌اند اما شماره یا ایمیل
                  ثبت‌شده ندارند؛ در ارسال وارد نمی‌شوند.
                </p>
              ) : null}
              {audience.excludedByConsent > 0 ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  اختلاف این دو عدد، مشتریانی است که اجازهٔ دریافت{" "}
                  {CAMPAIGN_CHANNEL_LABELS[audience.channel]} نداده‌اند و در ارسال حذف می‌شوند.
                </p>
              ) : null}
              {/*
                Tested against the same figure shown above, not against
                `reachable` alone: a segment where everyone consented but
                nobody has a phone number has a non-zero `reachable` and still
                reaches no one, which is exactly when this warning is needed.
              */}
              {Math.max(0, audience.reachable - audience.missingContact) === 0 ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  با این کانال، کمپین به هیچ‌کس نمی‌رسد؛ رضایت ارتباط مشتریان در برنامهٔ «ارتباط با
                  مشتری» ثبت و ویرایش می‌شود.
                </p>
              ) : null}
            </div>
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
