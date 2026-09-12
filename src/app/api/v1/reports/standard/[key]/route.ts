import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { reportShape, standardReportsFor } from "@/lib/reports";
import { runTradeReport } from "@/lib/trade-reports-service";
import {
  getBalanceSheet,
  getBalanceSheetComparison,
  getCashFlow,
  getCashFlowComparison,
  getProfitAndLoss,
  getProfitAndLossComparison,
  runStandardReportRows,
} from "@/lib/reports-service";

/**
 * Runs a standard report with both business and API-key branch boundaries.
 *
 * The key must belong to the business's own trade — same gate as the dashboard
 * route, so an integration cannot reach a report the UI would never list.
 */
export const GET = withApiKeyScope(
  async (apiKey, request: NextRequest, context: { params: Promise<{ key: string }> }) => {
    const denied = requireApiScope(apiKey.scopes, API_SCOPES.reportsRead);
    if (denied) return denied;

    const { key } = await context.params;
    const industry = await getBusinessIndustry(apiKey.businessId);
    const definition = standardReportsFor(industry).find((report) => report.key === key);
    if (!definition) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const dateFrom = searchParams.get("dateFrom") ?? undefined;
    const dateTo = searchParams.get("dateTo") ?? undefined;
    const compare = searchParams.get("compare") === "1";

    if (key === "profit_and_loss") {
      if (compare) {
        return NextResponse.json({
          comparison: await getProfitAndLossComparison(
            apiKey.businessId,
            { dateFrom, dateTo },
            apiKey.locationId,
          ),
        });
      }
      return NextResponse.json({
        report: await getProfitAndLoss(apiKey.businessId, { dateFrom, dateTo }, apiKey.locationId),
      });
    }
    if (key === "cash_flow") {
      if (compare) {
        return NextResponse.json({
          comparison: await getCashFlowComparison(apiKey.businessId, { dateFrom, dateTo }, apiKey.locationId),
        });
      }
      return NextResponse.json({
        report: await getCashFlow(apiKey.businessId, { dateFrom, dateTo }, apiKey.locationId),
      });
    }
    if (key === "balance_sheet") {
      if (compare) {
        const previousAsOfDate = searchParams.get("previousAsOfDate") ?? undefined;
        return NextResponse.json({
          comparison: await getBalanceSheetComparison(
            apiKey.businessId,
            dateTo,
            previousAsOfDate,
            apiKey.locationId,
          ),
        });
      }
      return NextResponse.json({
        report: await getBalanceSheet(apiKey.businessId, dateTo, apiKey.locationId),
      });
    }

    // The retail trades' own reports, scoped to the key's own branch.
    if (reportShape(definition) !== "rows") {
      const report = await runTradeReport(key, {
        businessId: apiKey.businessId,
        locationId: apiKey.locationId,
        industry: industry ?? "food_service",
        filters: { dateFrom, dateTo },
      });
      if (report) return NextResponse.json({ report });
    }

    const rows = await runStandardReportRows(
      key,
      apiKey.businessId,
      { dateFrom, dateTo },
      apiKey.locationId,
    );
    return NextResponse.json({ rows });
  },
);
