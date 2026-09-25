import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getActiveShift, shiftCashSummary } from "@/lib/shift-service";

/** The caller's own current shift (or null), plus a running cash summary — for the clock-in/out panel. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersCreate);
  if (error) return error;

  const shift = await getActiveShift(session.sub, session.businessId);
  if (!shift) return NextResponse.json({ shift: null });

  const cashSummary = await shiftCashSummary(session.sub, shift.startedAt, new Date());
  return NextResponse.json({ shift, cashSummary });
});
