import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getCustomerStatement } from "@/lib/ar-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** One customer's full AR activity (invoices + receipts) with a running balance. `id` may be "unknown" for unattributed lines. */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const { id } = await ctx.params;
  return NextResponse.json({ lines: await getCustomerStatement(session.businessId, id) });
});
