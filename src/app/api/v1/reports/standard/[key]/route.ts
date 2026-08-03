import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { STANDARD_REPORTS } from "@/lib/reports";
import {
  getBalanceSheet,
  getBalanceSheetComparison,
  getCashFlow,
  getCashFlowComparison,
  getProfitAndLoss,
  getProfitAndLossComparison,
  runStandardReportRows,
} from "@/lib/reports-service";

/** Runs a standard report with both business and API-key branch boundaries. */
export const GET = withApiKeyScope(
  async (apiKey, request: NextRequest, context: { params: Promise<{ key: string }> }) => {
    const denied = requireApiScope(apiKey.scopes, API_SCOPES.reportsRead);
    if (denied) return denied;

    const { key } = await context.params;
    const definition = STANDARD_REPORTS.find((report) => report.key === key);
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

    const rows = await runStandardReportRows(
      key,
      apiKey.businessId,
      { dateFrom, dateTo },
      apiKey.locationId,
    );
    return NextResponse.json({ rows });
  },
);
