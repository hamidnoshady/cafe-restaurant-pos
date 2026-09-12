"use client";

/**
 * The plan catalogue — «اشتراک پلتفرم».
 *
 * Split out of the billing page, which had grown into two errands under one
 * heading: topping up credit (money in) and choosing a plan (what the business
 * pays for). They are now `/settings/billing` and `/settings/subscription`,
 * two platform URLs an app can link to precisely, instead of one page an app
 * link had to dump somebody at the top of.
 *
 * Both are platform-owned. No app renders this component.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SparklesIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PLATFORM_BILLING_HREF } from "@/lib/app-routes";
import { SectionCard, SectionCardSkeleton, cardClass } from "@/app/dashboard/page-chrome";
import { ErrorBox, api, errorMessage } from "@/app/dashboard/ui";

interface Plan {
  key: string;
  name: string;
  description: string | null;
  monthlyPriceRial: number | null;
}

function toman(rial: number): string {
  return toPersianDigits((rial / 10).toLocaleString("en-US").replace(/,/g, "٬"));
}

export function SubscriptionManager() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { ok, data } = await api<{ plans: Plan[] }>("/api/billing/plans");
    setPlans(ok ? (data.plans ?? []) : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function buy(planKey: string) {
    setError("");
    setBusy(planKey);
    const { ok, data } = await api<{ redirectUrl?: string | null; error?: string; message?: string }>(
      "/api/billing/payments",
      { method: "POST", body: JSON.stringify({ kind: "plan", planKey }) },
    );
    if (!ok) {
      setError(data.message ?? errorMessage(data.error));
      setBusy(null);
      return;
    }
    if (data.redirectUrl) {
      window.location.assign(data.redirectUrl);
      return;
    }
    // A manual gateway records the request; the platform admin confirms it.
    setError("");
    setBusy(null);
    void load();
  }

  if (!plans) {
    return (
      <div aria-busy="true" aria-label="در حال بارگذاری">
        <SectionCardSkeleton label="طرح‌های اشتراک" rows={3} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <SectionCard
        title="طرح‌های اشتراک"
        description="طرح این کسب‌وکار در سطح پلتفرم تعیین می‌شود و روی همهٔ برنامه‌ها اثر دارد."
      >
        {plans.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            در حال حاضر طرحی برای فروش تعریف نشده است.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <div key={plan.key} className={cn("flex flex-col p-4", cardClass)}>
                <p className="flex items-center gap-2 font-bold">
                  <SparklesIcon aria-hidden="true" className="size-4 text-amber-600 dark:text-amber-400" />
                  {plan.name}
                </p>
                {plan.description ? (
                  <p className="mt-1 text-xs text-muted-foreground">{plan.description}</p>
                ) : null}
                <p className="mt-3 text-lg font-extrabold tabular-nums">
                  {plan.monthlyPriceRial == null || plan.monthlyPriceRial === 0
                    ? "رایگان"
                    : `${toman(plan.monthlyPriceRial)} تومان / ماهانه`}
                </p>
                {plan.monthlyPriceRial != null && plan.monthlyPriceRial > 0 ? (
                  <Button
                    variant="secondary"
                    className="mt-3 w-full"
                    disabled={busy !== null}
                    onClick={() => void buy(plan.key)}
                  >
                    {busy === plan.key ? "در حال انتقال…" : "خرید اشتراک"}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="اعتبار و پرداخت‌ها">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-sm leading-6 text-muted-foreground">
            خرید اشتراک از اعتبار کسب‌وکار انجام می‌شود؛ شارژ اعتبار و تاریخچهٔ پرداخت‌ها در صفحهٔ صورت‌حساب است.
          </p>
          <Button variant="secondary" asChild>
            <Link href={PLATFORM_BILLING_HREF}>صورت‌حساب پلتفرم</Link>
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
