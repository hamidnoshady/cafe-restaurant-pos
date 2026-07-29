import { NextRequest, NextResponse } from "next/server";
import {
  getPlatformAiConfig,
  savePlatformAiConfig,
  toPublicPlatformAiConfig,
  validatePlatformAiConfigInput,
  type PlatformAiConfigInput,
} from "@/lib/ai-config";
import {
  assignAiSubscription,
  grantAiCredits,
  listAiCreditPackages,
  listAiSubscriptionPlans,
  listPlatformAiBusinesses,
  listPlatformAiTopUpRequests,
  reviewAiTopUpRequest,
  saveAiCreditPackage,
  saveAiSubscriptionPlan,
} from "@/lib/ai-billing-service";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { getBusiness, setBusinessFeature } from "@/lib/platform-service";

/** Platform-wide AI operations: read analytics, configuration and credit control. */
export const GET = withPlatformScope(async () => {
  const { session, error } = await requirePlatformCapability("ai.read");
  if (error) return error;

  const [businesses, packages, subscriptions, topUps, config] = await Promise.all([
    listPlatformAiBusinesses(),
    listAiCreditPackages(),
    listAiSubscriptionPlans(),
    listPlatformAiTopUpRequests(),
    getPlatformAiConfig(),
  ]);

  const canManageConfig = session.role === "owner";
  return NextResponse.json({
    businesses,
    packages,
    subscriptions,
    topUps,
    // A support/engineer admin may read operational data but not the provider
    // connection, pricing inputs or even its masked key state.
    config: canManageConfig ? toPublicPlatformAiConfig(config) : null,
  });
});

function safeInteger(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function catalogueInput(body: Record<string, unknown>, creditKey: "creditAmountRial" | "monthlyCreditRial") {
  const priceRial = safeInteger(body.priceRial);
  const credit = safeInteger(body[creditKey]);
  const sortOrder = safeInteger(body.sortOrder);
  return {
    id: typeof body.id === "string" && body.id ? body.id : undefined,
    name: typeof body.name === "string" ? body.name : "",
    priceRial: priceRial ?? 0,
    [creditKey]: credit ?? 0,
    isActive: body.isActive !== false,
    sortOrder: sortOrder ?? 0,
  };
}

/** Owner-only provider connection and catalogue pricing policy. */
export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.config.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    if (body.action === "config") {
      const raw = body.config;
      if (!raw || typeof raw !== "object") {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      const config = raw as PlatformAiConfigInput;
      const errors = validatePlatformAiConfigInput(config);
      if (errors.length > 0) return NextResponse.json({ error: errors[0], errors }, { status: 400 });
      const saved = await savePlatformAiConfig(config);
      await platformAudit({
        adminId: session.padmin,
        action: "ai.config.save",
        entity: "platform_ai_config",
        entityId: "true",
        payload: { provider: saved.provider, model: saved.model, enabled: saved.enabled },
      });
      return NextResponse.json({ config: toPublicPlatformAiConfig(saved) });
    }

    if (body.action === "credit_package") {
      const pkg = await saveAiCreditPackage(catalogueInput(body, "creditAmountRial") as {
        id?: string;
        name: string;
        priceRial: number;
        creditAmountRial: number;
        isActive: boolean;
        sortOrder: number;
      });
      await platformAudit({
        adminId: session.padmin,
        action: "ai.credit_package.save",
        entity: "ai_credit_package",
        entityId: pkg.id,
        payload: { name: pkg.name, priceRial: pkg.priceRial, creditAmountRial: pkg.creditAmountRial },
      });
      return NextResponse.json({ package: pkg });
    }

    if (body.action === "subscription_plan") {
      const plan = await saveAiSubscriptionPlan(catalogueInput(body, "monthlyCreditRial") as {
        id?: string;
        name: string;
        priceRial: number;
        monthlyCreditRial: number;
        isActive: boolean;
        sortOrder: number;
      });
      await platformAudit({
        adminId: session.padmin,
        action: "ai.subscription_plan.save",
        entity: "ai_subscription_plan",
        entityId: plan.id,
        payload: { name: plan.name, priceRial: plan.priceRial, monthlyCreditRial: plan.monthlyCreditRial },
      });
      return NextResponse.json({ plan });
    }

    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  } catch (err) {
    if (err instanceof Error && (err.message === "invalid_ai_catalogue" || err.message === "not_found")) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
});

/** Engineer/owner credit actions and the existing AI feature-flag override. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.credits.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.action === "grant") {
    const businessId = typeof body.businessId === "string" ? body.businessId : "";
    const amountRial = safeInteger(body.amountRial);
    if (!businessId || !amountRial || amountRial < 1) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const business = await getBusiness(businessId);
    if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await grantAiCredits({
      businessId,
      amountRial,
      note: typeof body.note === "string" ? body.note.slice(0, 1_000) : undefined,
      platformAdminId: session.padmin,
    });
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "ai.credit.grant",
      entity: "ai_business_billing",
      entityId: businessId,
      payload: { amountRial },
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "subscription") {
    const businessId = typeof body.businessId === "string" ? body.businessId : "";
    const planId =
      body.subscriptionPlanId === null
        ? null
        : typeof body.subscriptionPlanId === "string"
          ? body.subscriptionPlanId
          : undefined;
    if (!businessId || planId === undefined) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const business = await getBusiness(businessId);
    if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });
    try {
      await assignAiSubscription({
        businessId,
        subscriptionPlanId: planId,
        platformAdminId: session.padmin,
      });
    } catch (err) {
      if (err instanceof Error && err.message === "not_found") {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      throw err;
    }
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "ai.subscription.assign",
      entity: "ai_business_billing",
      entityId: businessId,
      payload: { subscriptionPlanId: planId },
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "top_up_review") {
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const status = body.status === "approved" || body.status === "rejected" ? body.status : null;
    if (!requestId || !status) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    try {
      const topUp = await reviewAiTopUpRequest({
        requestId,
        status,
        platformAdminId: session.padmin,
      });
      await platformAudit({
        adminId: session.padmin,
        businessId: topUp.businessId,
        action: "ai.top_up.review",
        entity: "ai_top_up_request",
        entityId: topUp.id,
        payload: { status, creditAmountRial: topUp.creditAmountRial },
      });
      return NextResponse.json({ topUp });
    } catch (err) {
      if (err instanceof Error && err.message === "not_found") {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      if (err instanceof Error && err.message === "top_up_not_pending") {
        return NextResponse.json({ error: "top_up_not_pending" }, { status: 409 });
      }
      throw err;
    }
  }

  if (body.action === "feature") {
    const businessId = typeof body.businessId === "string" ? body.businessId : "";
    const enabled = body.enabled;
    if (!businessId || (enabled !== null && typeof enabled !== "boolean")) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const business = await getBusiness(businessId);
    if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await setBusinessFeature(businessId, "ai_assistant", enabled);
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "ai.feature.override",
      entity: "business_feature",
      entityId: "ai_assistant",
      payload: { enabled },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
