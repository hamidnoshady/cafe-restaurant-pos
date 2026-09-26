"use client";

/**
 * اشتراک‌ها — every business subscription in one table, each row acting
 * through the ONE subscription service (`changeBusinessPlan`,
 * cancel/reactivate/auto-renew) so the console and the payment flows share a
 * single lifecycle path. Status filter rides the query; every mutation is
 * audited server-side and requires `billing.manage`.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import {
  api,
  Button,
  Card,
  ErrorBox,
  InfoBox,
  selectClass,
  SkeletonRows,
  useCan,
} from "../../ui";
import { PlatformStatusBadge } from "@/components/platform/status-badge";
import { PlatformConfirmDialog } from "@/components/platform/dialogs";
import { formatJalali } from "@/lib/jalali";

interface Subscription {
  businessId: string;
  businessName: string | null;
  planKey: string;
  status: "trialing" | "active" | "past_due" | "cancelled" | "expired";
  startedAt: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEnd: string | null;
  graceEnd: string | null;
  cancelAtPeriodEnd: boolean;
  autoRenew: boolean;
  cancelledAt: string | null;
  lastRenewalAt: string | null;
}

const STATUS_LABELS: Record<Subscription["status"], string> = {
  trialing: "دورهٔ آزمایشی",
  active: "فعال",
  past_due: "عقب‌افتاده",
  cancelled: "لغو شده",
  expired: "منقضی",
};

const STATUS_TONES: Record<Subscription["status"], "success" | "info" | "warning" | "danger" | "muted"> = {
  trialing: "info",
  active: "success",
  past_due: "warning",
  cancelled: "muted",
  expired: "danger",
};

const STATUS_OPTIONS: { key: string; label: string }[] = [
  { key: "", label: "همهٔ وضعیت‌ها" },
  { key: "active", label: "فعال" },
  { key: "trialing", label: "دورهٔ آزمایشی" },
  { key: "past_due", label: "عقب‌افتاده" },
  { key: "cancelled", label: "لغو شده" },
  { key: "expired", label: "منقضی" },
];

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function BillingSubscriptionsTab() {
  const canManage = useCan()("billing.manage");
  const [status, setStatus] = useState("");
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [activePlans, setActivePlans] = useState<{ key: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Subscription | null>(null);
  const [planTarget, setPlanTarget] = useState<Subscription | null>(null);
  const [planChoice, setPlanChoice] = useState("");

  const load = useCallback(async () => {
    const { ok, data } = await api<{ subscriptions: Subscription[]; error?: string }>(
      `/api/platform/billing/subscriptions${status ? `?status=${status}` : ""}`,
    );
    if (ok) setSubscriptions(data.subscriptions);
    else setError(data.error ?? "بارگذاری اشتراک‌ها ممکن نشد.");
  }, [status]);

  useEffect(() => {
    setSubscriptions(null);
    void load();
  }, [load]);

  useEffect(() => {
    // The change-plan dropdown only ever offers ACTIVE plans (the lifecycle
    // rule: no new business may be placed on a draft or retired plan).
    void api<{ plans: { key: string; name: string; status: string }[]; error?: string }>(
      "/api/platform/billing/plans",
    ).then(({ ok, data }) => {
      if (ok) setActivePlans(data.plans.filter((p) => p.status === "active"));
    });
  }, []);

  async function run(sub: Subscription, body: Record<string, unknown>, label: string) {
    setBusy(`${sub.businessId}-${label}`);
    setError("");
    setInfo("");
    const { ok, data } = await api<{ error?: string }>("/api/platform/billing/subscriptions", {
      method: "POST",
      body: JSON.stringify({ businessId: sub.businessId, ...body }),
    });
    setBusy(null);
    if (ok) {
      setInfo(label === "change_plan" ? `پلن «${sub.businessName ?? sub.businessId}» تغییر کرد.` : "اشتراک به‌روزرسانی شد.");
      await load();
    } else {
      setError(errText(data.error));
    }
  }

  const errText = (code: string | undefined) =>
    code === "plan_not_found"
      ? "پلن یافت نشد."
      : code === "plan_not_active"
        ? "این پلن فعال نیست و قابل انتخاب نیست."
        : code === "subscription_not_found"
          ? "اشتراکی برای این کسب‌وکار ثبت نشده است."
          : code === "already_cancelled"
            ? "این اشتراک قبلاً لغو شده است."
            : `انجام نشد: ${code ?? ""}`;

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info && <InfoBox>{info}</InfoBox>}

      <Card title="اشتراک کسب‌وکارها">
        <div className="mb-4 flex items-center justify-between gap-2">
          <select
            className={selectClass + " h-9 w-44"}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          <Button variant="ghost" onClick={() => void load()} aria-label="بازخوانی">
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
        {!subscriptions ? (
          <SkeletonRows rows={6} />
        ) : subscriptions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            اشتراکی با این فیلتر یافت نشد.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-right text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-1">کسب‌وکار</th>
                  <th className="py-2">پلن</th>
                  <th className="py-2">وضعیت</th>
                  <th className="py-2">پایان دوره</th>
                  <th className="py-2">تمدید خودکار</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {subscriptions.map((sub) => {
                  const daysLeft = daysUntil(sub.currentPeriodEnd);
                  return (
                    <tr key={sub.businessId} className="border-b border-border align-top">
                      <td className="py-2 pr-1">
                        <Link
                          href={`/platform/businesses/${sub.businessId}/billing?tab=subscription`}
                          className="font-medium text-foreground underline-offset-4 hover:underline"
                        >
                          {sub.businessName ?? sub.businessId}
                        </Link>
                      </td>
                      <td className="py-2">{sub.planKey}</td>
                      <td className="py-2">
                        <PlatformStatusBadge label={STATUS_LABELS[sub.status]} tone={STATUS_TONES[sub.status]} />
                        {sub.cancelAtPeriodEnd && (
                          <span className="mr-1 block text-xs text-muted-foreground">لغو در پایان دوره</span>
                        )}
                        {sub.graceEnd && (
                          <span className="mr-1 block text-xs text-amber-700 dark:text-amber-300">
                            مهلت تا {formatJalali(sub.graceEnd, { withMonthName: true })}
                          </span>
                        )}
                      </td>
                      <td className="py-2 tabular-nums">
                        {formatJalali(sub.currentPeriodEnd, { withMonthName: true })}
                        {daysLeft != null && daysLeft >= 0 && daysLeft <= 7 && (
                          <span className="mr-1 block text-xs text-amber-700 dark:text-amber-300">
                            {daysLeft === 0 ? "امروز" : `${daysLeft} روز مانده`}
                          </span>
                        )}
                        {daysLeft != null && daysLeft < 0 && (
                          <span className="mr-1 block text-xs text-red-700 dark:text-red-300">گذشته</span>
                        )}
                      </td>
                      <td className="py-2">{sub.autoRenew ? "روشن" : "خاموش"}</td>
                      <td className="py-2 text-left">
                        {canManage && (
                          <div className="flex flex-wrap justify-end gap-1">
                            <button
                              type="button"
                              className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
                              onClick={() => {
                                setPlanTarget(sub);
                                setPlanChoice(sub.planKey);
                              }}
                              disabled={busy === `${sub.businessId}-change_plan`}
                            >
                              تغییر پلن
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
                              onClick={() =>
                                void run(sub, { action: "set_auto_renew", autoRenew: !sub.autoRenew }, "set_auto_renew")
                              }
                              disabled={busy?.startsWith(sub.businessId)}
                            >
                              {busy === `${sub.businessId}-set_auto_renew` ? (
                                <Loader2Icon className="inline size-3 animate-spin" />
                              ) : sub.autoRenew ? (
                                "خاموش‌کردن تمدید"
                              ) : (
                                "روشن‌کردن تمدید"
                              )}
                            </button>
                            {sub.status !== "cancelled" && sub.status !== "expired" && (
                              <button
                                type="button"
                                className="rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-500/10"
                                onClick={() => setCancelTarget(sub)}
                                disabled={busy?.startsWith(sub.businessId)}
                              >
                                لغو اشتراک
                              </button>
                            )}
                            {(sub.status === "cancelled" || sub.status === "expired" || sub.cancelAtPeriodEnd) && (
                              <button
                                type="button"
                                className="rounded-lg border border-emerald-500/40 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10"
                                onClick={() => void run(sub, { action: "reactivate" }, "reactivate")}
                                disabled={busy === `${sub.businessId}-reactivate`}
                              >
                                {busy === `${sub.businessId}-reactivate` ? (
                                  <Loader2Icon className="inline size-3 animate-spin" />
                                ) : (
                                  "فعال‌سازی دوباره"
                                )}
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <PlatformConfirmDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
        title="لغو اشتراک"
        description={`اشتراک «${cancelTarget?.businessName ?? ""}» در پلن ${cancelTarget?.planKey ?? ""} لغو شود؟ دسترسی در پایان دورهٔ جاری قطع می‌شود.`}
        confirmLabel="لغو اشتراک"
        variant="destructive"
        busy={cancelTarget ? busy === `${cancelTarget.businessId}-cancel` : false}
        onConfirm={async () => {
          if (cancelTarget) await run(cancelTarget, { action: "cancel", atPeriodEnd: true }, "cancel");
          setCancelTarget(null);
        }}
      />

      <PlatformConfirmDialog
        open={planTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPlanTarget(null);
        }}
        title="تغییر پلن"
        description={
          planTarget ? (
            <span className="block">
              پلن «{planTarget.businessName ?? planTarget.businessId}» از {planTarget.planKey} به کدام پلن تغییر کند؟
              <select className={selectClass + " mt-2"} value={planChoice} onChange={(e) => setPlanChoice(e.target.value)}>
                {activePlans.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name} ({p.key})
                  </option>
                ))}
              </select>
            </span>
          ) : null
        }
        confirmLabel="ثبت تغییر پلن"
        busy={planTarget ? busy === `${planTarget.businessId}-change_plan` : false}
        onConfirm={async () => {
          if (planTarget && planChoice) await run(planTarget, { action: "change_plan", planKey: planChoice }, "change_plan");
          setPlanTarget(null);
        }}
      />
    </div>
  );
}
