import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { brandSalesAnalysis } from "@/lib/industry-reports-service";

/** Sell-through by برند — which brands actually move. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "cosmetics");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ rows: [] });

  const params = request.nextUrl.searchParams;
  const rows = await brandSalesAnalysis(session.businessId, location.id, {
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    eventPrefix: "cosmetic",
  });
  return NextResponse.json({ rows });
});
