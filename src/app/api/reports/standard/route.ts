import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { REPORT_GROUP_LABELS, reportShape, standardReportsFor } from "@/lib/reports";

/**
 * The pre-built report library, as this business's trade actually sees it.
 *
 * Filtered server-side rather than in the UI: the list and
 * `/api/reports/standard/[key]` must agree about what exists, or a café-only
 * report would be listed for a jeweller and then refused when run. Both read
 * `standardReportsFor`, so there is one answer.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const industry = await getBusinessIndustry(session.businessId);
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
