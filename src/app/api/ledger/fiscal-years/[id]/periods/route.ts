import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { FiscalPeriodError, listPeriods } from "@/lib/fiscal-periods-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** A fiscal year's twelve periods, in calendar order. */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    return NextResponse.json({ periods: await listPeriods(session.businessId, id) });
  } catch (err) {
    if (err instanceof FiscalPeriodError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
