import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  platformAudit,
  withPlatformScope,
} from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import {
  cancelBusinessSubscription,
  getBusinessSubscription,
  listSubscriptions,
  reactivateBusinessSubscription,
  setAutoRenew,
  changeBusinessPlan,
  SubscriptionError,
  type SubscriptionStatus,
} from "@/lib/subscription-service";

/** Every business subscription, optionally by status — the subscriptions tab. */
export const GET = withPlatformScope(async (req: NextRequest) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") as SubscriptionStatus | null;
  if (status && !["trialing", "active", "past_due", "cancelled", "expired"].includes(status)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  return NextResponse.json({
    subscriptions: await listSubscriptions({ status: status ?? undefined, limit: 300 }),
  });
});

/**
 * Subscription actions — every one through the subscription service (the ONE
 * lifecycle path), each audited:
 *   { action: "change_plan", businessId, planKey }
 *   { action: "cancel",      businessId, atPeriodEnd? }
 *   { action: "reactivate",  businessId }
 *   { action: "set_auto_renew", businessId, autoRenew }
 */
export const POST = withPlatformScope(async (req: NextRequest) => {
  const guard = await requirePlatformCapability("billing.manage");
  if (guard.error) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const action = String(body.action ?? "");
  const businessId = String(body.businessId ?? "");
  if (!businessId || !action) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const business = await getBusiness(businessId);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    switch (action) {
      case "change_plan": {
        const planKey = String(body.planKey ?? "").trim();
        if (!planKey) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
        const outcome = await changeBusinessPlan({ businessId, planKey, source: "admin" });
        await platformAudit({
          adminId: guard.session.padmin,
          businessId,
          action: outcome.outcome === "created" ? "subscription.created" : "subscription.changed",
          entity: "business_subscriptions",
          entityId: businessId,
          payload: { from: business.plan, to: planKey, source: "admin" },
        });
        return NextResponse.json({ subscription: outcome.subscription });
      }
      case "cancel": {
        const atPeriodEnd = body.atPeriodEnd !== false;
        const subscription = await cancelBusinessSubscription(businessId, { atPeriodEnd });
        await platformAudit({
          adminId: guard.session.padmin,
          businessId,
          action: "subscription.cancelled",
          entity: "business_subscriptions",
          entityId: businessId,
          payload: { atPeriodEnd, planKey: subscription.planKey },
        });
        return NextResponse.json({ subscription });
      }
      case "reactivate": {
        const subscription = await reactivateBusinessSubscription(businessId);
        await platformAudit({
          adminId: guard.session.padmin,
          businessId,
          action: "subscription.changed",
          entity: "business_subscriptions",
          entityId: businessId,
          payload: { to: "active", planKey: subscription.planKey },
        });
        return NextResponse.json({ subscription });
      }
      case "set_auto_renew": {
        const autoRenew = body.autoRenew === true;
        const subscription = await setAutoRenew(businessId, autoRenew);
        await platformAudit({
          adminId: guard.session.padmin,
          businessId,
          action: "subscription.changed",
          entity: "business_subscriptions",
          entityId: businessId,
          payload: { autoRenew, planKey: subscription.planKey },
        });
        return NextResponse.json({ subscription });
      }
      case "get": {
        return NextResponse.json({ subscription: await getBusinessSubscription(businessId) });
      }
      default:
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof SubscriptionError) {
      const status = err.code === "business_not_found" ? 404 : 400;
      return NextResponse.json({ error: err.code }, { status });
    }
    throw err;
  }
});
