import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getBusinessOverview } from "@/lib/reports-service";

/**
 * Phase 14 — consolidated numbers across a business's own branches.
 *
 * Distinct from Phase 9's `/api/rollup/*`: that aggregates other *servers*
 * pushing summaries over HTTP. This queries the Phase 8 reporting views
 * directly for branches sharing this database, so a branch's row here is
 * computed the same way its own reports are — there's no second code path
 * for the numbers to disagree through.
 *
 * Owner-only, matching the Phase 9 precedent that cross-branch comparison is
 * one step more restricted than a single branch's own reports.
 */
export async function GET(request: NextRequest) {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  const dateFrom = request.nextUrl.searchParams.get("dateFrom") ?? undefined;
  const dateTo = request.nextUrl.searchParams.get("dateTo") ?? undefined;

  return NextResponse.json(await getBusinessOverview(session.businessId, { dateFrom, dateTo }));
}
