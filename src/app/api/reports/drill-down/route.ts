import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getAccountDrillDown } from "@/lib/reports-service";

/**
 * The journal entries behind one account's figure in a statement — what
 * "drill down to the journal entries behind any figure" (Phase 16 exit
 * criterion) means in practice: click a line in P&L/Balance Sheet/Cash Flow,
 * see exactly which postings sum to it.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const accountCode = searchParams.get("accountCode");
  if (!accountCode) return NextResponse.json({ error: "missing_account_code" }, { status: 400 });

  const dateFrom = searchParams.get("dateFrom") ?? undefined;
  const dateTo = searchParams.get("dateTo") ?? undefined;

  const lines = await getAccountDrillDown(session.businessId, accountCode, { dateFrom, dateTo });
  return NextResponse.json({ lines });
});
