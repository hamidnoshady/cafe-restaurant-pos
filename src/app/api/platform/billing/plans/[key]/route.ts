import { NextResponse } from "next/server";
import { requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import { deleteDraftPlan, getBillingPlan } from "@/lib/billing-plans-service";

/**
 * Hard-delete a plan. Only an unused DRAFT may be removed (the service
 * enforces the rule; the businesses.plan FK is the hard backstop). Active and
 * retired plans are lifecycle-managed through POST /plans { action }.
 */
export const DELETE = withPlatformScope(
  async (_req: Request, ctx: { params: Promise<{ key: string }> }) => {
    const guard = await requirePlatformCapability("plans.manage");
    if (guard.error) return guard.error;
    const { key } = await ctx.params;

    const plan = await getBillingPlan(key);
    if (!plan) return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
    try {
      await deleteDraftPlan(key);
    } catch (err) {
      if (err instanceof Error && ["plan_not_draft", "plan_in_use", "plan_not_found"].includes(err.message)) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
    await platformAudit({
      adminId: guard.session.padmin,
      action: "plan.deleted",
      entity: "billing_plans",
      entityId: key,
      payload: { name: plan.name },
    });
    return NextResponse.json({ ok: true });
  },
);
