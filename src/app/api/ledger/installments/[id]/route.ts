import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getInstallmentPlan } from "@/lib/installments-service";

/** One plan with its slices — the «جزئیات» overlay's data. */
export const GET = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;
  const { id } = await context.params;
  const plan = await getInstallmentPlan(session.businessId, id);
  if (!plan) return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
  return NextResponse.json({ plan });
});
