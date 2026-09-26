import { NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getSpendPolicy, saveSpendPolicy } from "@/lib/billing/runtime";

export const GET = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  const businessId = new URL(req.url).searchParams.get("businessId");
  if (!businessId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json({ policy: await getSpendPolicy(businessId) });
});

export const PUT = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  const body = (await req.json().catch(() => null)) as {
    businessId?: string;
    monthlyBudgetRial?: number | null;
    actionAtLimit?: "continue" | "warn_only" | "block_noncritical" | "throttle_noncritical";
    thresholds?: number[];
  } | null;
  if (!body?.businessId || !body.actionAtLimit) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  await saveSpendPolicy({
    businessId: body.businessId,
    monthlyBudgetRial: body.monthlyBudgetRial ?? null,
    actionAtLimit: body.actionAtLimit,
    thresholds: body.thresholds,
  });
  return NextResponse.json({ policy: await getSpendPolicy(body.businessId) });
});
