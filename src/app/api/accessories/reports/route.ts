import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { variantSalesAnalysis } from "@/lib/industry-reports-service";

/** تحلیل فروش تنوع‌ها — which variants actually sell, read straight off the sale events. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "accessories");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ rows: [] });

  const params = request.nextUrl.searchParams;
  const rows = await variantSalesAnalysis(session.businessId, location.id, {
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  });
  return NextResponse.json({ rows });
});
