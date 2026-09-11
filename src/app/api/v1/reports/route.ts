import { NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { REPORT_GROUP_LABELS, reportShape, standardReportsFor } from "@/lib/reports";

/**
 * Lists the report keys that a reports.read integration can request.
 *
 * Scoped to the key's own business's trade, like the dashboard list it mirrors:
 * an integration should not be told about «چرخش میزها» for a jewellery shop and
 * then get a 404 when it asks for it.
 */
export const GET = withApiKeyScope(async (apiKey) => {
  const denied = requireApiScope(apiKey.scopes, API_SCOPES.reportsRead);
  if (denied) return denied;

  const industry = await getBusinessIndustry(apiKey.businessId);
  const reports = standardReportsFor(industry).map((report) => ({
    key: report.key,
    label: report.label,
    description: report.description ?? null,
    group: report.group,
    groupLabel: REPORT_GROUP_LABELS[report.group],
    shape: reportShape(report),
    chartType: report.defaultChart?.chartType ?? null,
    config: report.defaultChart?.config ?? null,
  }));
  return NextResponse.json({ reports });
});
