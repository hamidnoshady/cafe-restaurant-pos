import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listBillingPlans } from "@/lib/billing-plans-service";

/**
 * Active billing plans for the tenant billing page. Owners/managers only —
 * pricing is business-facing but not something a cashier needs.
 */
export const GET = withTenantScope(async () => {
  const { error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;
  return NextResponse.json({ plans: await listBillingPlans(true) });
});
