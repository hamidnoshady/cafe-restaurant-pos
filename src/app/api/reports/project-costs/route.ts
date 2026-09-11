import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { listProjectCostReport } from "@/lib/ai-projects";

/** Project-cost report: accounting documents are the source of every spend figure. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;
  const rows = await listProjectCostReport({ businessId: session.businessId, actorUserId: session.sub });
  return NextResponse.json({ rows });
});
