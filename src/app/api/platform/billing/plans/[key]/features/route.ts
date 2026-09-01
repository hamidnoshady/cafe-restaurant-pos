import { NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { deletePlanFeature, listPlanFeatures, savePlanFeature } from "@/lib/billing-plans-service";

/** Per-feature pricing rows for one plan. */
export const GET = withPlatformScope(
  async (_req: Request, ctx: { params: Promise<{ key: string }> }) => {
    const { key } = await ctx.params;
    return NextResponse.json({ features: await listPlanFeatures(key) });
  },
);

/**
 * Add / update a feature's price on a plan — the core of the plan builder:
 * pick a feature, choose included / monthly / per-use / add-on, set the cost,
 * and optionally a free-for-time (freeUntil) or free-for-N-uses (freeLimit)
 * promotion.
 */
export const POST = withPlatformScope(
  async (req: Request, ctx: { params: Promise<{ key: string }> }) => {
    const guard = await requirePlatformCapability("billing.manage");
    if (guard.error) return guard.error;
    const { key: planKey } = await ctx.params;

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const featureKey = String(body.featureKey ?? "").trim();
    const pricingModel = String(body.pricingModel ?? "");
    if (!featureKey) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    if (!["included", "monthly", "per_use", "addon"].includes(pricingModel)) {
      return NextResponse.json({ error: "bad_pricing_model" }, { status: 400 });
    }

    const feature = await savePlanFeature({
      planKey,
      featureKey,
      pricingModel: pricingModel as "included" | "monthly" | "per_use" | "addon",
      priceRial: Math.max(0, Math.floor(Number(body.priceRial ?? 0))),
      freeUntil: typeof body.freeUntil === "string" && body.freeUntil ? body.freeUntil : null,
      freeLimit:
        body.freeLimit === "" || body.freeLimit == null
          ? null
          : Math.max(0, Math.floor(Number(body.freeLimit))),
      sortOrder: Math.floor(Number(body.sortOrder ?? 0)) || 0,
    });
    return NextResponse.json({ feature });
  },
);

/** Remove a feature's pricing row from a plan (feature stays in the catalogue). */
export const DELETE = withPlatformScope(
  async (req: Request, ctx: { params: Promise<{ key: string }> }) => {
    const guard = await requirePlatformCapability("billing.manage");
    if (guard.error) return guard.error;
    const { key: planKey } = await ctx.params;
    const url = new URL(req.url);
    const featureKey = url.searchParams.get("featureKey");
    if (!featureKey) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    await deletePlanFeature(planKey, featureKey);
    return NextResponse.json({ ok: true });
  },
);
