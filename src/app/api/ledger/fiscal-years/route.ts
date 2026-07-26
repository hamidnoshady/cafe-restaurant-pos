import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireRole, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createFiscalYear, FiscalPeriodError, listFiscalYears } from "@/lib/fiscal-periods-service";

/** Every fiscal year defined for this business. Any owner/manager may read; only owner/accountant may define one (see POST). */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  return NextResponse.json({ fiscalYears: await listFiscalYears(session.businessId) });
});

/**
 * Defines a fiscal year (the Jalali year `jy`) and its twelve periods.
 * `ledger.close_period` — owner and accountant — the same permission that
 * gates soft-closing/locking a period, since defining a year is the same
 * kind of act: setting up the structure the rest of the phase's period
 * enforcement runs against.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerClosePeriod);
  if (error) return error;

  let body: { year?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const jy = Number(body.year);
  if (!Number.isInteger(jy) || jy < 1300 || jy > 1500) {
    return NextResponse.json({ error: "invalid_year" }, { status: 400 });
  }

  try {
    const fiscalYear = await createFiscalYear(session.businessId, jy);
    return NextResponse.json({ fiscalYear }, { status: 201 });
  } catch (err) {
    if (err instanceof FiscalPeriodError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
