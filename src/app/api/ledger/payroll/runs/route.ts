import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { accruePayroll, listPayrollRuns, MissingLedgerAccountError, PayrollError } from "@/lib/payroll-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;

  const runs = await listPayrollRuns(session.businessId);
  return NextResponse.json({ runs });
});

/** Accrues a new payroll run against every active staff member's current monthly wage. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  let body: { periodLabel?: unknown; accrualDate?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // `String(body.periodLabel ?? "")` accepted anything — a number posted a run
  // labelled «12345», an object one labelled «[object Object]». A period is a
  // heading somebody types, so it must arrive as a string (or be absent, which
  // the service rejects with `period_label_required`).
  if (body.periodLabel !== undefined && typeof body.periodLabel !== "string") {
    return NextResponse.json({ error: "period_label_required" }, { status: 400 });
  }
  if (body.accrualDate !== undefined && body.accrualDate !== null && typeof body.accrualDate !== "string") {
    return NextResponse.json({ error: "invalid_accrual_date" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const run = await accruePayroll({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      periodLabel: body.periodLabel ?? "",
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
