import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { MissingLedgerAccountError, PayrollError, payPayroll } from "@/lib/payroll-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

interface Ctx {
  params: Promise<{ id: string }>;
}

const METHODS = ["cash", "bank"] as const;

/** Pays out an accrued payroll run: Debit salariesPayable / Credit the chosen Cash or Bank-Clearing account. */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { method?: unknown; paidDate?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // no body is fine; method defaults to cash
  }
  /*
   * An unrecognised method used to fall back to `cash` silently, so a typo or
   * a stale client posted the wage bill out of the till while the caller
   * believed it went out of the bank — the two credit different accounts
   * (۱۱۰۰ vs ۱۱۲۰) and the entry cannot be told apart afterwards. Absent still
   * means cash (the documented default); a *wrong* value is now refused.
   */
  if (body.method !== undefined && !METHODS.includes(body.method as (typeof METHODS)[number])) {
    return NextResponse.json({ error: "invalid_method" }, { status: 400 });
  }
  const method = (body.method as "cash" | "bank" | undefined) ?? "cash";
  if (body.paidDate !== undefined && body.paidDate !== null && typeof body.paidDate !== "string") {
    return NextResponse.json({ error: "invalid_paid_date" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const run = await payPayroll({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      runId: id,
      method,
      paidDate: body.paidDate as string | undefined,
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
