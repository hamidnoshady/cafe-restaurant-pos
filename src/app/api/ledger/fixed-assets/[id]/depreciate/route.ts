import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { FixedAssetError, postDepreciation } from "@/lib/fixed-assets-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Posts one period's straight-line depreciation for this asset. */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const { id } = await ctx.params;
  let body: { periodLabel?: string; entryDate?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const result = await postDepreciation({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      fixedAssetId: id,
      periodLabel: String(body.periodLabel ?? ""),
      entryDate: body.entryDate,
      createdBy: session.sub,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
