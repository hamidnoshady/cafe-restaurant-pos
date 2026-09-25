import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listProjectCostReport } from "@/lib/ai-projects";

/** Project-cost report: accounting documents are the source of every spend figure. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;
  const rows = await listProjectCostReport({ businessId: session.businessId, actorUserId: session.sub });
  return NextResponse.json({ rows });
});
