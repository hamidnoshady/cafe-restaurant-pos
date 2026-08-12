import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getShiftOrdersReport } from "@/lib/shift-orders-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Item-by-item order detail for one shift of the active branch's recent
 * shifts (default: the current one), for the reports UI's "سفارش‌های شیفت"
 * tab. Guarded like the rest of /api/reports (owner/manager/accountant)
 * rather than like /api/shifts — this is report reading, not staff
 * administration, and it never exposes another branch's orders because the
 * shift list and the rows both come from `resolveActiveLocation`.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ report: null });

  const { searchParams } = new URL(request.url);
  return NextResponse.json({
    report: await getShiftOrdersReport(location.id, searchParams.get("shiftId") ?? undefined),
  });
});
