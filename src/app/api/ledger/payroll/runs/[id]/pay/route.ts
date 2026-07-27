import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { MissingLedgerAccountError, PayrollError, payPayroll } from "@/lib/payroll-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

interface Ctx {
  params: Promise<{ id: string }>;
}

const METHODS = ["cash", "bank"] as const;

/** Pays out an accrued payroll run: Debit salariesPayable / Credit the chosen Cash or Bank-Clearing account. */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireRole("owner", "accountant");
  if (error) return error;

  const { id } = await ctx.params;
  let body: { method?: string; paidDate?: string } = {};
  try {
    body = await request.json();
  } catch {
    // no body is fine; method defaults to cash
  }
  const method = METHODS.includes(body.method as (typeof METHODS)[number]) ? (body.method as "cash" | "bank") : "cash";

  const location = await resolveActiveLocation(session);

  try {
    const run = await payPayroll({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      runId: id,
      method,
      paidDate: body.paidDate,
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
