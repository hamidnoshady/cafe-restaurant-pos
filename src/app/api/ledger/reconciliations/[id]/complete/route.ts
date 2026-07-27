import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { completeReconciliation, ReconciliationError } from "@/lib/reconciliation-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Locks a reconciliation — only once its cleared lines exactly account for the statement balance. */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const { id } = await ctx.params;
  try {
    const reconciliation = await completeReconciliation({
      businessId: session.businessId,
      reconciliationId: id,
      actorId: session.sub,
    });
    return NextResponse.json(reconciliation);
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
