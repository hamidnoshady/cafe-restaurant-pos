import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { PayrollError, setWage } from "@/lib/payroll-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireRole("owner", "accountant");
  if (error) return error;

  const { id } = await ctx.params;
  let body: { monthlyWage?: number | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    await setWage(session.businessId, id, body.monthlyWage === null || body.monthlyWage === undefined ? null : Number(body.monthlyWage));
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PayrollError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
