import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { STANDARD_REPORTS } from "@/lib/reports";
import {
  getBalanceSheet,
  getBalanceSheetComparison,
  getCashFlow,
  getCashFlowComparison,
  getFoodCostVariance,
  getProfitAndLoss,
  getProfitAndLossComparison,
  runStandardReportRows,
} from "@/lib/reports-service";

/**
 * Runs one pre-built report. P&L/Balance Sheet/Cash Flow/Food-Cost-Variance
 * are structured rollups computed straight from the ledger (see
 * reports-service.ts); every other standard report is a plain row dump of
 * its backing view, optionally bounded by a date range. `?compare=1` returns
 * `{ comparison: {current, previous} }` instead of `{ report }` — the
 * previous period mirrors the given range's length for P&L/Cash Flow, or is
 * the explicit `previousAsOfDate` for Balance Sheet, which has no length to
 * mirror (food-cost-variance doesn't support `compare` — see its UI note).
 */
export const GET = withTenantScope(async (request: NextRequest, context: { params: Promise<{ key: string }> }) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;
  const { key } = await context.params;

  const def = STANDARD_REPORTS.find((r) => r.key === key);
  if (!def) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("dateFrom") ?? undefined;
  const dateTo = searchParams.get("dateTo") ?? undefined;
  const compare = searchParams.get("compare") === "1";

  if (key === "profit_and_loss") {
    if (compare) {
      return NextResponse.json({
        comparison: await getProfitAndLossComparison(session.businessId, { dateFrom, dateTo }),
      });
    }
    return NextResponse.json({ report: await getProfitAndLoss(session.businessId, { dateFrom, dateTo }) });
  }
  if (key === "cash_flow") {
    if (compare) {
      return NextResponse.json({
        comparison: await getCashFlowComparison(session.businessId, { dateFrom, dateTo }),
      });
    }
    return NextResponse.json({ report: await getCashFlow(session.businessId, { dateFrom, dateTo }) });
  }
  if (key === "balance_sheet") {
    if (compare) {
      const previousAsOfDate = searchParams.get("previousAsOfDate") ?? undefined;
      return NextResponse.json({
        comparison: await getBalanceSheetComparison(session.businessId, dateTo, previousAsOfDate),
      });
    }
    return NextResponse.json({ report: await getBalanceSheet(session.businessId, dateTo) });
  }
  if (key === "food_cost_variance") {
    return NextResponse.json({ report: await getFoodCostVariance(session.businessId, { dateFrom, dateTo }) });
  }
  const rows = await runStandardReportRows(key, session.businessId, { dateFrom, dateTo });
  return NextResponse.json({ rows });
});
