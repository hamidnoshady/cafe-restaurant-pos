import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PayrollError, setWage } from "@/lib/payroll-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { monthlyWage?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  /*
   * `Number(…)` used to coerce the body, which quietly accepted values that
   * are not amounts: `true` became 1 rial, `[]` and `""` became 0, and a
   * missing key became `null` — so a malformed request silently *cleared* or
   * mangled somebody's wage instead of being refused. Only a real number (or
   * an explicit null, meaning «no wage set») is a wage; the service still
   * range-checks it.
   */
  const raw = body.monthlyWage;
  let monthlyWage: number | null;
  if (raw === null || raw === undefined) monthlyWage = null;
  else if (typeof raw === "number") monthlyWage = raw;
  else return NextResponse.json({ error: "invalid_amount" }, { status: 400 });

  try {
    await setWage(session.businessId, id, monthlyWage);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PayrollError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
