import { NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { STANDARD_REPORTS } from "@/lib/reports";

/** Lists the report keys that a reports.read integration can request. */
export const GET = withApiKeyScope(async (apiKey) => {
  const denied = requireApiScope(apiKey.scopes, API_SCOPES.reportsRead);
  if (denied) return denied;

  const reports = STANDARD_REPORTS.map((report) => ({
    key: report.key,
    label: report.label,
    chartType: report.defaultChart?.chartType ?? null,
    config: report.defaultChart?.config ?? null,
  }));
  return NextResponse.json({ reports });
});
