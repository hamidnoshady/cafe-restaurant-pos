import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { customerUsageSummary } from "@/lib/billing/runtime";
import { getWallet } from "@/lib/wallet-service";
import { getBusinessSubscription } from "@/lib/subscription-service";
import { getSpendPolicy } from "@/lib/billing/runtime";

/** Customer usage for the current billing period. Amounts are integer Rial. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;
  const [usage, wallet, subscription, spend] = await Promise.all([
    customerUsageSummary(session.businessId),
    getWallet(session.businessId),
    getBusinessSubscription(session.businessId),
    getSpendPolicy(session.businessId),
  ]);
  return NextResponse.json({
    usage,
    wallet: { balanceRial: wallet.balanceRial },
    subscription: subscription
      ? {
          planKey: subscription.planKey,
          status: subscription.status,
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
          autoRenew: subscription.autoRenew,
        }
      : null,
    spend,
  });
});
