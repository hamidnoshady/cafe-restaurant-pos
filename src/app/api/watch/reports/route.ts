import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { repairReport, warrantyReport } from "@/lib/industry-reports-service";

/** گزارش گارانتی و تعمیرات — warranty windows classified as of today, and repair throughput/profitability. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({
      warranty: { rows: [], counts: { active: 0, expiring: 0, expired: 0, none: 0 } },
      repairs: { rows: [], byStatus: {}, totals: { revenue: 0, partsCost: 0, margin: 0 } },
    });
  }

  const params = request.nextUrl.searchParams;
  const [warranty, repairs] = await Promise.all([
    warrantyReport(location.id, { asOfDate: params.get("asOf") ?? undefined }),
    repairReport(location.id, {
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
    }),
  ]);
  return NextResponse.json({ warranty, repairs });
});
