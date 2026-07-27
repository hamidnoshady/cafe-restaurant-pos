import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getReconciliation, ReconciliationError } from "@/lib/reconciliation-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** One reconciliation's candidate/cleared lines and computed balances. */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const { id } = await ctx.params;
  try {
    return NextResponse.json(await getReconciliation(session.businessId, id));
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
