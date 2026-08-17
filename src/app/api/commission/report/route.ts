import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { staffCommissionReport } from "@/lib/commission-service";

/** The per-staff commission leaderboard — Σ signed accruals per employee. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const from = request.nextUrl.searchParams.get("from") ?? null;
  const to = request.nextUrl.searchParams.get("to") ?? null;
  return NextResponse.json({ report: await staffCommissionReport(session.businessId, { from, to }) });
});
