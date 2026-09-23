import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { parseReportOrderFilters } from "@/lib/report-order-filters";
import { getShiftOrdersReport } from "@/lib/shift-orders-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/** Branch-scoped, paginated order report. All filtering happens in PostgreSQL. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ report: null });

  const parsed = parseReportOrderFilters(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return NextResponse.json({
    report: await getShiftOrdersReport(location.id, { ...parsed.filters, timeZone: location.timezone }),
  });
});
