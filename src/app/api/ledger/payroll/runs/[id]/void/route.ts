import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { MissingLedgerAccountError, PayrollError, voidPayrollRun } from "@/lib/payroll-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Voids a payroll run: posts the exact mirror of its accrual (and its payment,
 * if paid), dated today rather than backdated — the reversal path every other
 * ledger surface has. Owner + accountant only, the same gate as accruing and
 * paying, since a void is an equally ledger-altering action.
 */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  const { id } = await ctx.params;
  const location = await resolveActiveLocation(session);

  try {
    const run = await voidPayrollRun({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      runId: id,
      actorId: session.sub,
    });
    return NextResponse.json({ run });
  } catch (err) {
    if (err instanceof PayrollError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
