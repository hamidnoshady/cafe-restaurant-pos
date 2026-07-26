import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { STANDARD_REPORTS } from "@/lib/reports";

/** The pre-built report library — key/label list for the standard-reports UI. */
export const GET = withTenantScope(async () => {
  const { error } = await requireRole("owner", "manager");
  if (error) return error;

  const reports = STANDARD_REPORTS.map((r) => ({
    key: r.key,
    label: r.label,
    chartType: r.defaultChart?.chartType ?? null,
    config: r.defaultChart?.config ?? null,
  }));
  return NextResponse.json({ reports });
});
