"use client";

/**
 * پرداخت‌ها — two panels, one place:
 *
 *   1. صف بازبینی دستی — bank-transfer payments and messaging-credit top-up
 *      requests awaiting a super-admin decision. Approving follows the SAME
 *      activation path as a verified gateway payment (settle + fulfil); there
 *      is no separate manual-approval money path.
 *   2. دفتر پرداخت‌ها — every payment row across businesses, filterable by
 *      status. Verification is always server-authoritative (gateway verify /
 *      super-admin review); nothing here trusts the client.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
import { api, Card, ErrorBox, InfoBox, selectClass, SkeletonRows, useCan } from "../../ui";
import { PlatformStatusBadge } from "@/components/platform/status-badge";
import { PlatformConfirmDialog } from "@/components/platform/dialogs";
import { formatJalali } from "@/lib/jalali";
import { tomanLabel } from "@/lib/platform-money";

interface Payment {
  id: string;
  businessId: string;
  businessName: string | null;
  gateway: "manual" | "zarinpal";
  purpose: "top_up" | "plan_purchase" | "addon_purchase";
  packageId: string | null;
  planKey: string | null;
  featureKey: string | null;
  amountRial: number;
  creditRial: number;
  description: string;
  status: "pending" | "redirect" | "verified" | "failed" | "cancelled";
  authority: string | null;
  gatewayRef: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

interface MessageTopUp {
  id: string;
  businessId: string;
  businessName: string | null;
  packageName: string;
  priceRial: number;
  creditAmountRial: number;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  reviewedAt: string | null;
  createdAt: string;
}

const PAY_STATUS_LABELS: Record<Payment["status"], string> = {
  pending: "در انتظار",
  redirect: "در انتظار بازگشت از درگاه",
  verified: "تأیید شده",
  failed: "ناموفق",
  cancelled: "لغو شده",
};
const PAY_STATUS_TONES: Record<Payment["status"], "success" | "info" | "warning" | "danger" | "muted"> = {
  pending: "warning",
  redirect: "info",
  verified: "success",
  failed: "danger",
  cancelled: "muted",
};
const PURPOSE_LABELS: Record<Payment["purpose"], string> = {
  top_up: "شارژ کیف پول",
  plan_purchase: "خرید پلن",
  addon_purchase: "خرید افزونه",
};
const GATEWAY_LABELS: Record<Payment["gateway"], string> = {
  manual: "کارت به کارت",
  zarinpal: "زرین‌پال",
};
const TOPUP_STATUS_LABELS: Record<MessageTopUp["status"], string> = {
  pending: "در انتظار بازبینی",
  approved: "تأیید شده",
  rejected: "رد شده",
};
const TOPUP_STATUS_TONES: Record<MessageTopUp["status"], "warning" | "success" | "danger"> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
};

export function BillingPaymentsTab() {
  const canReview = useCan()("payments.review");
  const canManage = useCan()("billing.manage");
  const canAct = canReview || canManage;

  const [status, setStatus] = useState("");
  const [queue, setQueue] = useState<{ manualPayments: Payment[]; messageTopUps: MessageTopUp[] } | null>(null);
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<
    | { kind: "payment"; id: string; action: "approve" | "reject"; title: string; description: string }
    | { kind: "message_topup"; id: string; action: "approve" | "reject"; title: string; description: string }
    | null
  >(null);

  const loadQueue = useCallback(async () => {
    const { ok, data } = await api<
      { manualPayments: Payment[]; messageTopUps: MessageTopUp[]; error?: string }
    >("/api/platform/billing/manual-review");
    if (ok) setQueue(data);
    else setError(data.error ?? "بارگذاری صف بازبینی ممکن نشد.");
  }, []);

  const loadLedger = useCallback(async () => {
    const { ok, data } = await api<{ payments: Payment[]; error?: string }>(
      `/api/platform/billing/payments${status ? `?status=${status}` : ""}`,
    );
    if (ok) setPayments(data.payments);
    else setError(data.error ?? "بارگذاری پرداخت‌ها ممکن نشد.");
  }, [status]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);
  useEffect(() => {
    setPayments(null);
    void loadLedger();
  }, [loadLedger]);

  async function review(
    target:
      | { kind: "payment"; id: string; action: "approve" | "reject" }
      | { kind: "message_topup"; id: string; action: "approve" | "reject" },
  ) {
    setBusy(`${target.kind}-${target.id}`);
    setError("");
    setInfo("");
    const { ok, data } = await api<{ error?: string; message?: string }>(
      "/api/platform/billing/manual-review",
      {
        method: "POST",
        body: JSON.stringify(target),
      },
    );
    setBusy(null);
    setConfirmTarget(null);
    if (ok) {
      setInfo(target.action === "approve" ? "تأیید شد و اعتبار/اشتراک اعمال گردید." : "رد شد.");
      await Promise.all([loadQueue(), loadLedger()]);
    } else {
      setError(
        data.error === "payment_not_found"
          ? "پرداخت یافت نشد."
          : data.error === "not_found"
            ? "درخواست یافت نشد."
            : data.error === "top_up_not_pending"
              ? "این درخواست قبلاً بازبینی شده است."
              : `انجام نشد: ${data.error ?? data.message ?? ""}`,
      );
    }
  }

  const pendingPayments = queue?.manualPayments.filter((p) => p.status === "pending") ?? [];
  const settledManual = queue?.manualPayments.filter((p) => p.status !== "pending") ?? [];
  const pendingTopUps = queue?.messageTopUps.filter((t) => t.status === "pending") ?? [];
  const settledTopUps = queue?.messageTopUps.filter((t) => t.status !== "pending") ?? [];

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info && <InfoBox>{info}</InfoBox>}

      <Card
        title={
          "صف بازبینی دستی" +
          (pendingPayments.length + pendingTopUps.length > 0
            ? ` (${pendingPayments.length + pendingTopUps.length} مورد در انتظار)`
            : "")
        }
      >
        {!queue ? (
          <SkeletonRows rows={4} />
        ) : pendingPayments.length + pendingTopUps.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            موردی در انتظار بازبینی نیست.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-right text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-1">نوع</th>
                  <th className="py-2">کسب‌وکار</th>
                  <th className="py-2">شرح</th>
                  <th className="py-2">مبلغ</th>
                  <th className="py-2">درگاه</th>
                  <th className="py-2">تاریخ</th>
                  {canAct && <th className="py-2" />}
                </tr>
              </thead>
              <tbody>
                {pendingPayments.map((p) => (
                  <tr key={p.id} className="border-b border-border">
                    <td className="py-2 pr-1">{PURPOSE_LABELS[p.purpose]}</td>
                    <td className="py-2">
                      <Link href={`/platform/businesses/${p.businessId}/billing`} className="underline-offset-4 hover:underline">
                        {p.businessName ?? p.businessId}
                      </Link>
                    </td>
                    <td className="py-2">{p.description || "—"}</td>
                    <td className="py-2 tabular-nums">{tomanLabel(p.amountRial)}</td>
                    <td className="py-2">{GATEWAY_LABELS[p.gateway]}</td>
                    <td className="py-2 tabular-nums">{formatJalali(p.createdAt, { withTime: true })}</td>
                    {canAct && (
                      <td className="py-2 text-left">
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10"
                            disabled={busy === `payment-${p.id}`}
                            onClick={() =>
                              setConfirmTarget({
                                kind: "payment",
                                id: p.id,
                                action: "approve",
                                title: "تأیید پرداخت دستی",
                                description: `پرداخت ${tomanLabel(p.amountRial)} («${p.businessName ?? p.businessId}») تأیید و اعتبار/اشتراک آن اعمال شود؟`,
                              })
                            }
                          >
                            {busy === `payment-${p.id}` ? (
                              <Loader2Icon className="size-3.5 animate-spin" />
                            ) : (
                              <CheckIcon className="size-3.5" />
                            )}
                            تأیید
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-500/10"
                            disabled={busy === `payment-${p.id}`}
                            onClick={() =>
                              setConfirmTarget({
                                kind: "payment",
                                id: p.id,
                                action: "reject",
                                title: "رد پرداخت دستی",
                                description: `پرداخت ${tomanLabel(p.amountRial)} («${p.businessName ?? p.businessId}») رد شود؟ هیچ مبلغی جابه‌جا نمی‌شود.`,
                              })
                            }
                          >
                            <XIcon className="size-3.5" />
                            رد
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {pendingTopUps.map((t) => (
                  <tr key={`topup-${t.id}`} className="border-b border-border">
                    <td className="py-2 pr-1">اعتبار پیام‌رسانی</td>
                    <td className="py-2">
                      <Link href={`/platform/businesses/${t.businessId}/billing`} className="underline-offset-4 hover:underline">
                        {t.businessName ?? t.businessId}
                      </Link>
                    </td>
                    <td className="py-2">
                      {t.packageName}
                      {t.note ? <span className="block text-xs text-muted-foreground">{t.note}</span> : null}
                    </td>
                    <td className="py-2 tabular-nums">{tomanLabel(t.priceRial)}</td>
                    <td className="py-2">کارت به کارت</td>
                    <td className="py-2 tabular-nums">{formatJalali(t.createdAt, { withTime: true })}</td>
                    {canAct && (
                      <td className="py-2 text-left">
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10"
                            disabled={busy === `message_topup-${t.id}`}
                            onClick={() =>
                              setConfirmTarget({
                                kind: "message_topup",
                                id: t.id,
                                action: "approve",
                                title: "تأیید درخواست شارژ پیام",
                                description: `اعتبار ${tomanLabel(t.creditAmountRial)} بستهٔ «${t.packageName}» برای «${t.businessName ?? t.businessId}» شارژ شود؟`,
                              })
                            }
                          >
                            {busy === `message_topup-${t.id}` ? (
                              <Loader2Icon className="size-3.5 animate-spin" />
                            ) : (
                              <CheckIcon className="size-3.5" />
                            )}
                            تأیید
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-500/10"
                            disabled={busy === `message_topup-${t.id}`}
                            onClick={() =>
                              setConfirmTarget({
                                kind: "message_topup",
                                id: t.id,
                                action: "reject",
                                title: "رد درخواست شارژ پیام",
                                description: `درخواست بستهٔ «${t.packageName}» («${t.businessName ?? t.businessId}») رد شود؟`,
                              })
                            }
                          >
                            <XIcon className="size-3.5" />
                            رد
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(settledManual.length > 0 || settledTopUps.length > 0) && (
          <p className="mt-3 text-xs text-muted-foreground">
            {settledManual.length} پرداخت و {settledTopUps.length} درخواست شارژ پیام اخیراً بازبینی شده‌اند —
            وضعیت آن‌ها در دفتر پرداخت‌ها و «تاریخچه تغییرات» قابل پیگیری است.
          </p>
        )}
      </Card>

      <Card title="دفتر پرداخت‌ها">
        <div className="mb-4 flex items-center justify-between gap-2">
          <select
            className={selectClass + " h-9 w-48"}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">همهٔ وضعیت‌ها</option>
            <option value="pending">در انتظار</option>
            <option value="redirect">در انتظار بازگشت از درگاه</option>
            <option value="verified">تأیید شده</option>
            <option value="failed">ناموفق</option>
            <option value="cancelled">لغو شده</option>
          </select>
          <button
            type="button"
            onClick={() => {
              void loadQueue();
              void loadLedger();
            }}
            className="rounded-lg border border-border p-2 text-foreground hover:bg-muted"
            aria-label="بازخوانی"
          >
            <RefreshCwIcon className="size-4" />
          </button>
        </div>

        {!payments ? (
          <SkeletonRows rows={6} />
        ) : payments.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">پرداختی با این فیلتر یافت نشد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-right text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-1">کسب‌وکار</th>
                  <th className="py-2">نوع</th>
                  <th className="py-2">مبلغ</th>
                  <th className="py-2">اعتبار</th>
                  <th className="py-2">درگاه</th>
                  <th className="py-2">وضعیت</th>
                  <th className="py-2">تاریخ</th>
                  <th className="py-2">مرجع</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b border-border">
                    <td className="py-2 pr-1">
                      <Link href={`/platform/businesses/${p.businessId}/billing`} className="underline-offset-4 hover:underline">
                        {p.businessName ?? p.businessId}
                      </Link>
                    </td>
                    <td className="py-2">{PURPOSE_LABELS[p.purpose]}</td>
                    <td className="py-2 tabular-nums">{tomanLabel(p.amountRial)}</td>
                    <td className="py-2 tabular-nums">{p.creditRial > 0 ? tomanLabel(p.creditRial) : "—"}</td>
                    <td className="py-2">{GATEWAY_LABELS[p.gateway]}</td>
                    <td className="py-2">
                      <PlatformStatusBadge
                        label={PAY_STATUS_LABELS[p.status]}
                        tone={PAY_STATUS_TONES[p.status]}
                      />
                    </td>
                    <td className="py-2 tabular-nums">{formatJalali(p.createdAt, { withTime: true })}</td>
                    <td className="py-2 font-mono text-xs text-muted-foreground" dir="ltr">
                      {p.gatewayRef ?? p.authority ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          تأیید پرداخت همیشه سمت سرور انجام می‌شود (واسط پرداخت یا بازبینی مدیر)؛ بازبینی دستی همین مسیر تأیید را
          طی می‌کند و شماره تراکنش در دفتر ثبت می‌ماند.
        </p>
      </Card>

      <PlatformConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
        title={confirmTarget?.title ?? ""}
        description={confirmTarget?.description}
        confirmLabel={confirmTarget?.action === "approve" ? "تأیید" : "رد"}
        variant={confirmTarget?.action === "reject" ? "destructive" : "default"}
        busy={confirmTarget ? busy === `${confirmTarget.kind}-${confirmTarget.id}` : false}
        onConfirm={() => {
          if (confirmTarget) void review({ kind: confirmTarget.kind, id: confirmTarget.id, action: confirmTarget.action });
        }}
      />
    </div>
  );
}
