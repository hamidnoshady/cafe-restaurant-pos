import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { reportShape, standardReportsFor } from "@/lib/reports";
import { resolveActiveLocation } from "@/lib/setup-state";
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
import { runTradeReport } from "@/lib/trade-reports-service";

/**
 * Runs one pre-built report. P&L/Balance Sheet/Cash Flow/Food-Cost-Variance
 * are structured rollups computed straight from the ledger (see
 * reports-service.ts); the retail trades' own reports (weight reconciliation,
 * warranty register, variant sell-through, …) are computed by their trade's
 * service through `runTradeReport`; every other standard report is a plain row
 * dump of its backing view, optionally bounded by a date range. `?compare=1`
 * returns `{ comparison: {current, previous} }` instead of `{ report }` — the
 * previous period mirrors the given range's length for P&L/Cash Flow, or is
 * the explicit `previousAsOfDate` for Balance Sheet, which has no length to
 * mirror (food-cost-variance doesn't support `compare` — see its UI note).
 *
 * The report must belong to this business's trade: the lookup is over
 * `standardReportsFor(industry)`, not the whole library, so a key another trade
 * owns 404s here exactly as an invented one does. Without that, hiding a report
 * from the list would be decoration — the route would still run it.
 */
export const GET = withTenantScope(async (request: NextRequest, context: { params: Promise<{ key: string }> }) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;
  const { key } = await context.params;

  const industry = await getBusinessIndustry(session.businessId);
  const def = standardReportsFor(industry).find((r) => r.key === key);
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

  // The retail trades' own reports. Branch-scoped like the manager tabs they
  // came from — each reads one branch's stock, serials or weights, not the
  // business's whole book.
  if (reportShape(def) !== "rows") {
    const location = await resolveActiveLocation(session);
    const report = await runTradeReport(key, {
      businessId: session.businessId,
      locationId: location?.id ?? null,
      industry: industry ?? "food_service",
      filters: { dateFrom, dateTo },
    });
    if (report) return NextResponse.json({ report });
  }

  const rows = await runStandardReportRows(key, session.businessId, { dateFrom, dateTo });
  return NextResponse.json({ rows });
});
