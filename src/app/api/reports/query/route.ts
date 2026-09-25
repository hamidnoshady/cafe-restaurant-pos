import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { validateReportConfig, type ReportConfig } from "@/lib/reports";
import { runCustomReportQuery } from "@/lib/reports-service";

/** Runs an ad-hoc custom report config (the report builder's "preview" / final run). */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsExport);
  if (error) return error;

  let config: ReportConfig;
  try {
    config = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const errors = validateReportConfig(config);
  if (errors.length > 0) {
    return NextResponse.json({ error: "invalid_config", details: errors }, { status: 400 });
  }

  const rows = await runCustomReportQuery(session.businessId, config);
  return NextResponse.json({ rows });
});
