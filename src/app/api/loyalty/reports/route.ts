import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { loyaltyRedemptionReport } from "@/lib/loyalty-service";

/** گزارش وفاداری — earned vs redeemed points (and redeemed Rial value) over a window. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.loyaltyView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  try {
    const report = await loyaltyRedemptionReport(session.businessId, {
      from: params.get("from") ?? null,
      to: params.get("to") ?? null,
    });
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json({ error: "invalid_range", message: (err as Error).message }, { status: 400 });
  }
});
