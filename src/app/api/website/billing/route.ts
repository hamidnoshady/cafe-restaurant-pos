import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  cancelWebsiteSubscription,
  chargeSubscriptionPeriod,
  getWebsiteSubscription,
  listWebsiteCharges,
  listWebsitePlans,
  startWebsiteSubscription,
  WalletInsufficientFundsError,
} from "@/lib/website/billing-service";
import { getWalletBalanceRial } from "@/lib/wallet-service";

/**
 * `GET /api/website/billing` — the site's plan, its subscription and every
 * charge it has run up, with the wallet balance those charges come out of.
 *
 * «سایت‌ساز کار سایت را می‌کند؛ پول را این‌جا می‌گیریم.» The CMS has no wallet
 * and sends no invoice; this is the whole money side of running a platform
 * site, and it settles against the same balance the assistant and messaging
 * draw on.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.websiteView);
  if (error) return error;

  const [plans, subscription, charges, balanceRial] = await Promise.all([
    listWebsitePlans(),
    getWebsiteSubscription(session.businessId),
    listWebsiteCharges(session.businessId),
    getWalletBalanceRial(session.businessId),
  ]);
  const response = NextResponse.json({ plans, subscription, charges, balanceRial });
  response.headers.set("Cache-Control", "no-store");
  return response;
});

/**
 * `POST /api/website/billing` — start or change the plan (`{ planKey }`),
 * pay the current period (`{ action: "pay" }`), or stop auto-renewal
 * (`{ action: "cancel" }`).
 *
 * Owner only: each of the three commits the business to, or releases it from,
 * a recurring charge.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingManage);
  if (error) return error;

  let body: { planKey?: string; action?: string };
  try {
    body = (await request.json()) as { planKey?: string; action?: string };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.action === "cancel") {
    const subscription = await cancelWebsiteSubscription(session.businessId);
    return NextResponse.json({ subscription });
  }

  if (body.action === "pay") {
    try {
      const outcome = await chargeSubscriptionPeriod(session.businessId);
      if (!outcome) return NextResponse.json({ error: "no_subscription" }, { status: 409 });
      return NextResponse.json({ outcome });
    } catch (err) {
      if (err instanceof WalletInsufficientFundsError) {
        return NextResponse.json({ error: "insufficient_credit" }, { status: 402 });
      }
      throw err;
    }
  }

  if (typeof body.planKey !== "string" || !body.planKey.trim()) {
    return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  }
  const subscription = await startWebsiteSubscription(session.businessId, body.planKey.trim());
  if (!subscription) return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  return NextResponse.json({ subscription });
});
