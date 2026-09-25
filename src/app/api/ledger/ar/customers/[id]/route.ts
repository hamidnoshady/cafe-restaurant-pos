import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getCustomerStatement } from "@/lib/ar-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** One customer's full AR activity (invoices + receipts) with a running balance. `id` may be "unknown" for unattributed lines. */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  return NextResponse.json({ lines: await getCustomerStatement(session.businessId, id) });
});
