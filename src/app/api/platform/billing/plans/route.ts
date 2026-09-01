import { NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  listBillingPlans,
  listFeatureCatalogue,
  listPlanFeatures,
  saveBillingPlan,
} from "@/lib/billing-plans-service";

/**
 * The plan builder catalogue: every billing plan, each one's per-feature
 * pricing rows, and the feature catalogue rows can be attached.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const [plans, catalogue] = await Promise.all([listBillingPlans(false), listFeatureCatalogue()]);
  const featuresByPlan = await Promise.all(
    plans.map((p) => listPlanFeatures(p.key).then((rows) => [p.key, rows] as const)),
  );
  return NextResponse.json({
    plans,
    catalogue,
    featuresByPlan: Object.fromEntries(featuresByPlan),
  });
});

/** Create or update a billing plan (the bundle itself, not its features). */
export const POST = withPlatformScope(async (req: Request) => {
  const guard = await requirePlatformCapability("billing.manage");
  if (guard.error) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const monthlyPrice =
    body.monthlyPriceRial == null || body.monthlyPriceRial === ""
      ? null
      : Math.max(0, Math.floor(Number(body.monthlyPriceRial)));

  const plan = await saveBillingPlan({
    key: typeof body.key === "string" && body.key ? body.key : undefined,
    name,
    description: typeof body.description === "string" ? body.description : null,
    monthlyPriceRial: monthlyPrice,
    isActive: body.isActive !== false,
    sortOrder: Math.floor(Number(body.sortOrder ?? 0)) || 0,
  });
  return NextResponse.json({ plan });
});
