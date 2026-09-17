import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import {
  deleteReconciliation,
  getReconciliation,
  ReconciliationError,
} from "@/lib/reconciliation-service";

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

/**
 * Cancels an in-progress reconciliation.
 *
 * The one escape from a reconciliation opened with a wrong statement date or
 * balance: it can never be made to balance, a completed one is immutable and
 * the unique index allows only one in progress per account — so before this
 * existed, one typo left the account's whole screen stuck for good. A
 * *completed* reconciliation is still immutable; the service refuses it.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const { id } = await ctx.params;
  try {
    await deleteReconciliation({ businessId: session.businessId, reconciliationId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
