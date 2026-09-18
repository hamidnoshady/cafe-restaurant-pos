"use client";

/**
 * اشتراک و صورت‌حساب سایت — what the platform site costs, and what it has cost.
 *
 * «سایت‌ساز کار سایت را می‌کند؛ پول را این‌جا می‌گیریم.» The CMS renders and
 * serves the site and has no wallet, no plan and no invoice; everything on
 * this screen is this app's own record, settled against the same platform
 * credit the assistant and messaging draw on — which is why the balance and
 * the «افزایش اعتبار» link go to the one billing page the business already
 * knows.
 *
 * Every date here is Shamsi, through `formatJalali`; every amount is Toman,
 * from integer-Rial storage.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CreditCardIcon, RefreshCwIcon, WalletIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatJalali } from "@/lib/jalali";
import { formatToman } from "@/lib/money";
import {
  isRenewalDue,
  totalChargedRial,
  WEBSITE_CHARGE_LABELS,
  WEBSITE_SUBSCRIPTION_STATUS_LABELS,
  type WebsiteCharge,
  type WebsitePlan,
  type WebsiteSubscription,
} from "@/lib/website/billing";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import {
  EmptyState,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessageOrRaw, inputClass } from "@/app/dashboard/ui";

interface BillingState {
  plans: WebsitePlan[];
  subscription: WebsiteSubscription | null;
  charges: WebsiteCharge[];
  balanceRial: number;
}

export function CmsBillingSection() {
  const [state, setState] = useState<BillingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [planKey, setPlanKey] = useState("");

  const reload = useCallback(() => {
    setLoading(true);
    api<BillingState & { error?: string }>("/api/website/billing").then(({ ok, data }) => {
      setLoading(false);
      if (!ok) {
        setError(errorMessageOrRaw(data.error));
        return;
      }
      setState(data);
      setPlanKey(data.subscription?.planKey ?? "");
    });
  }, []);

  useEffect(reload, [reload]);

  const post = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/website/billing", {
      method: "POST",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    toast.success(success);
    reload();
  };

  if (loading) return <SectionCardSkeleton rows={4} />;
  if (!state) return <ErrorBox>{error || "صورت‌حساب سایت خوانده نشد."}</ErrorBox>;

  const { subscription, plans, charges, balanceRial } = state;
  const activePlans = plans.filter((plan) => plan.isActive);
  const due = subscription ? isRenewalDue(subscription, new Date().toISOString()) : false;

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>

      <SectionCard
        title="اشتراک سایت"
        description="هزینهٔ ماهانهٔ سایت از اعتبار پلتفرم کم می‌شود — همان اعتباری که برای دستیار و پیامک استفاده می‌کنید."
        actions={
          subscription ? (
            <StatusBadge
              tone={
                subscription.status === "active"
                  ? "positive"
                  : subscription.status === "past_due"
                    ? "danger"
                    : subscription.status === "cancelled"
                      ? "neutral"
                      : "active"
              }
            >
              {WEBSITE_SUBSCRIPTION_STATUS_LABELS[subscription.status]}
            </StatusBadge>
          ) : (
            <StatusBadge tone="neutral">بدون اشتراک</StatusBadge>
          )
        }
      >
        {subscription ? (
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">طرح</dt>
              <dd className="mt-0.5 text-sm font-medium text-foreground">
                {plans.find((plan) => plan.key === subscription.planKey)?.name ?? subscription.planKey}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">هزینهٔ ماهانه</dt>
              <dd className="mt-0.5 text-sm font-medium text-foreground">
                {formatToman(subscription.monthlyPriceRial)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">پایان دورهٔ فعلی</dt>
              <dd className="mt-0.5 text-sm font-medium text-foreground">
                {formatJalali(subscription.currentPeriodEnd, { withMonthName: true })}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">تمدید خودکار</dt>
              <dd className="mt-0.5 text-sm font-medium text-foreground">
                {subscription.autoRenew ? "روشن" : "خاموش"}
              </dd>
            </div>
          </dl>
        ) : (
          <EmptyState>هنوز طرحی برای این سایت انتخاب نشده است.</EmptyState>
        )}

        {due ? (
          <p className="mt-3 rounded-xl bg-muted px-3 py-2.5 text-xs leading-5 text-muted-foreground">
            دورهٔ فعلی به پایان رسیده است؛ با «پرداخت دورهٔ جاری» تمدید می‌شود.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="min-w-48 flex-1">
            <span className="mb-1.5 block text-xs text-muted-foreground">انتخاب طرح</span>
            <select className={inputClass} value={planKey} onChange={(event) => setPlanKey(event.target.value)}>
              <option value="">— طرحی انتخاب نشده —</option>
              {activePlans.map((plan) => (
                <option key={plan.key} value={plan.key}>
                  {plan.name} — ماهانه {formatToman(plan.monthlyPriceRial)}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            disabled={busy || !planKey || planKey === subscription?.planKey}
            onClick={() => post({ planKey }, "طرح سایت ثبت شد.")}
          >
            <CreditCardIcon className="size-4" />
            {subscription ? "تغییر طرح" : "شروع اشتراک"}
          </Button>
          {subscription ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="px-4"
                disabled={busy}
                onClick={() => post({ action: "pay" }, "دورهٔ جاری پرداخت شد.")}
              >
                <RefreshCwIcon className="size-4" />
                پرداخت دورهٔ جاری
              </Button>
              {subscription.autoRenew ? (
                <Button
                  type="button"
                  variant="outline"
                  className="px-4 text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm("تمدید خودکار متوقف شود؟ سایت تا پایان دورهٔ پرداخت‌شده فعال می‌ماند.")) return;
                    void post({ action: "cancel" }, "تمدید خودکار متوقف شد.");
                  }}
                >
                  توقف تمدید خودکار
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="اعتبار پلتفرم"
        description="همهٔ هزینه‌های سایت، دامنه و تمدید از این اعتبار کم می‌شود."
        actions={
          <Button asChild variant="outline" className="px-4">
            <Link href="/settings/billing">
              <WalletIcon className="size-4" />
              افزایش اعتبار
            </Link>
          </Button>
        }
      >
        <p className="text-sm text-foreground">
          موجودی فعلی: <span className="font-bold">{formatToman(balanceRial)}</span>
        </p>
      </SectionCard>

      <SectionCard
        title="هزینه‌های سایت"
        description={`مجموع ثبت‌شده تا امروز: ${formatToman(totalChargedRial(charges))}`}
      >
        {charges.length === 0 ? (
          <EmptyState>هنوز هزینه‌ای برای این سایت ثبت نشده است.</EmptyState>
        ) : (
          <DataTable caption="سوابق هزینهٔ سایت" tableClassName="min-w-[34rem]">
            <DataTableHead>
              <Th>تاریخ</Th>
              <Th>بابت</Th>
              <Th>شرح</Th>
              <Th numeric>مبلغ</Th>
            </DataTableHead>
            <DataTableBody>
              {charges.map((charge) => (
                <DataTableRow key={charge.id}>
                  <Td muted nowrap>
                    {formatJalali(charge.occurredAt)}
                  </Td>
                  <Td>{WEBSITE_CHARGE_LABELS[charge.kind] ?? charge.kind}</Td>
                  <Td muted>{charge.description}</Td>
                  <Td numeric>{formatToman(charge.amountRial)}</Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>
    </div>
  );
}
