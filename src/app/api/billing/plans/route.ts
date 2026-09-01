import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { listBillingPlans } from "@/lib/billing-plans-service";

/**
 * Active billing plans for the tenant billing page. Owners/managers only —
 * pricing is business-facing but not something a cashier needs.
 */
export const GET = withTenantScope(async () => {
  const { error } = await requireRole("owner", "manager");
  if (error) return error;
  return NextResponse.json({ plans: await listBillingPlans(true) });
});
