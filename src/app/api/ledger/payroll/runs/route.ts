import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { accruePayroll, listPayrollRuns, MissingLedgerAccountError, PayrollError } from "@/lib/payroll-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "accountant");
  if (error) return error;

  const runs = await listPayrollRuns(session.businessId);
  return NextResponse.json({ runs });
});

/** Accrues a new payroll run against every active staff member's current monthly wage. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "accountant");
  if (error) return error;

  let body: { periodLabel?: string; accrualDate?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const run = await accruePayroll({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      periodLabel: String(body.periodLabel ?? ""),
      accrualDate: body.accrualDate,
      createdBy: session.sub,
    });
    return NextResponse.json({ run }, { status: 201 });
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
