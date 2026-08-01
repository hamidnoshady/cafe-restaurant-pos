import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { validateReportConfig, type ReportConfig } from "@/lib/reports";
import { runCustomReportQuery } from "@/lib/reports-service";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function configFromSearchParams(searchParams: URLSearchParams): ReportConfig {
  const equals: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    if (key.startsWith("filter.")) equals[key.slice("filter.".length)] = value;
  }

  const dateFrom = searchParams.get("dateFrom") ?? undefined;
  const dateTo = searchParams.get("dateTo") ?? undefined;
  const filters =
    dateFrom || dateTo || Object.keys(equals).length > 0
      ? { dateFrom, dateTo, ...(Object.keys(equals).length > 0 ? { equals } : {}) }
      : undefined;

  const rawLimit = searchParams.get("limit");
  const hasSort = searchParams.has("sortBy") || searchParams.has("sortDir");
  return {
    view: searchParams.get("view") ?? "",
    metric: searchParams.get("metric") ?? "",
    aggregation: (searchParams.get("aggregation") ?? "") as ReportConfig["aggregation"],
    dimension: searchParams.get("dimension") ?? "",
    filters,
    sort: hasSort
      ? {
          by: searchParams.get("sortBy") === "metric" ? "metric" : "dimension",
          dir: searchParams.get("sortDir") === "desc" ? "desc" : "asc",
        }
      : undefined,
    limit: rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit),
  };
}

/**
 * Runs a whitelist-backed report query. Query-string filters use filter.<key>
 * and are validated against the same report-view catalogue as the dashboard.
 */
export const GET = withApiKeyScope(async (apiKey, request: NextRequest) => {
  const denied = requireApiScope(apiKey.scopes, API_SCOPES.reportsRead);
  if (denied) return denied;

  const config = configFromSearchParams(new URL(request.url).searchParams);
  if (!Number.isInteger(config.limit) || config.limit < 1 || config.limit > MAX_LIMIT) {
    return NextResponse.json({ error: "invalid_limit" }, { status: 400 });
  }

  const errors = validateReportConfig(config);
  if (errors.length > 0) {
    return NextResponse.json({ error: "invalid_config", details: errors }, { status: 400 });
  }

  const rows = await runCustomReportQuery(apiKey.businessId, config, apiKey.locationId);
  return NextResponse.json({ rows });
});
