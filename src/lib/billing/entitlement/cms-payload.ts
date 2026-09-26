import { query } from "../../db";
import { resolveFeatureAccess } from "../../billing-plans-service";
import type { EntitlementLimitClause, EntitlementPayloadV1 } from "../contract/v1";

function limitClause(value: number | null | undefined): EntitlementLimitClause {
  if (value == null || value <= 0) return { state: "unlimited" };
  return { state: "limit", value: Math.trunc(value) };
}

/** Build the v1 entitlement document CMS expects for one connected site. */
export async function buildCmsEntitlementPayload(input: {
  businessId: string;
  siteId: string;
  version: number;
}): Promise<EntitlementPayloadV1> {
  const { rows: subRows } = await query<{
    plan_key: string;
    status: string;
    current_period_start: Date | string | null;
    current_period_end: Date | string | null;
  }>(
    `SELECT plan_key, status, current_period_start, current_period_end
       FROM business_subscriptions WHERE business_id = $1`,
    [input.businessId],
  );
  const sub = subRows[0];
  const planKey = sub?.plan_key ?? "free";
  const status = sub?.status ?? "active";
  const serving = status === "active" || status === "trialing" || status === "past_due";

  const { rows: webSub } = await query<{ plan_key: string; status: string }>(
    `SELECT plan_key, status FROM website_service_subscriptions WHERE business_id = $1 LIMIT 1`,
    [input.businessId],
  );
  const { rows: webPlan } = await query<{
    max_pages: number | null;
    max_products: number | null;
  }>(
    `SELECT max_pages, max_products FROM website_service_plans WHERE key = $1`,
    [webSub[0]?.plan_key ?? "starter"],
  );

  const cmsAccess = await resolveFeatureAccess(input.businessId, "website.cms");
  const cmsEntitled = cmsAccess.entitled;
  const features: Record<string, boolean> = {
    "website.cms": cmsEntitled,
    store: cmsEntitled,
    blog: cmsEntitled,
  };

  const limits: Record<string, EntitlementLimitClause> = {};
  const pages = webPlan[0]?.max_pages ?? null;
  const products = webPlan[0]?.max_products ?? null;
  if (pages != null) limits.pages = limitClause(pages);
  if (products != null) limits.products = limitClause(products);

  const periodStart = sub?.current_period_start
    ? sub.current_period_start instanceof Date
      ? sub.current_period_start.toISOString()
      : new Date(sub.current_period_start).toISOString()
    : null;
  const periodEnd = sub?.current_period_end
    ? sub.current_period_end instanceof Date
      ? sub.current_period_end.toISOString()
      : new Date(sub.current_period_end).toISOString()
    : null;

  const payload: EntitlementPayloadV1 = {
    features,
    limits,
    planCode: planKey || "free",
    serving: serving && cmsEntitled,
    siteId: input.siteId,
    subscriptionStatus: status,
    version: input.version,
  };
  if (periodStart) payload.billingCycleStart = periodStart;
  if (periodEnd) payload.billingCycleEnd = periodEnd;
  payload.effectiveAt = new Date().toISOString();
  return payload;
}
