import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  discardReconciliation,
  getReconciliation,
  ReconciliationError,
} from "@/lib/reconciliation-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** One reconciliation's candidate/cleared lines and computed balances. */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    return NextResponse.json(await getReconciliation(session.businessId, id));
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});

/**
 * Discard an in-progress reconciliation, so a mistyped statement balance does
 * not wedge the account. Completed reconciliations are immutable — they are
 * the next period's opening balance.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    await discardReconciliation({ businessId: session.businessId, reconciliationId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
