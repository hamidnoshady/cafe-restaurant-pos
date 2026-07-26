import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { STANDARD_REPORTS } from "@/lib/reports";
import { getBalanceSheet, getProfitAndLoss, runStandardReportRows } from "@/lib/reports-service";

/**
 * Runs one pre-built report. P&L/Balance Sheet are structured account-type
 * rollups computed straight from the ledger (see reports-service.ts); every
 * other standard report is a plain row dump of its backing view, optionally
 * bounded by a date range.
 */
export const GET = withTenantScope(async (request: NextRequest, context: { params: Promise<{ key: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { key } = await context.params;

  const def = STANDARD_REPORTS.find((r) => r.key === key);
  if (!def) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("dateFrom") ?? undefined;
  const dateTo = searchParams.get("dateTo") ?? undefined;

  if (key === "profit_and_loss") {
    return NextResponse.json({ report: await getProfitAndLoss(session.businessId, { dateFrom, dateTo }) });
  }
  if (key === "balance_sheet") {
    return NextResponse.json({ report: await getBalanceSheet(session.businessId, dateTo) });
  }
  const rows = await runStandardReportRows(key, session.businessId, { dateFrom, dateTo });
  return NextResponse.json({ rows });
});
