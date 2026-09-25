import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { addDays, isValidBusinessDay } from "@/lib/rollup";
import { getBusinessToday, getRollupOverview } from "@/lib/rollup-service";

/** The Owner's cross-location comparison (central side). Defaults to the last 30 business days. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.rollupManage);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const today = await getBusinessToday(session.businessId);
  const rawFrom = params.get("from");
  const rawTo = params.get("to");
  const to = rawTo && isValidBusinessDay(rawTo) ? rawTo : today;
  const from = rawFrom && isValidBusinessDay(rawFrom) ? rawFrom : addDays(to, -29);
  if (from > to) return NextResponse.json({ error: "invalid_range" }, { status: 400 });

  const overview = await getRollupOverview(session.businessId, from, to);
  return NextResponse.json({ overview });
});
