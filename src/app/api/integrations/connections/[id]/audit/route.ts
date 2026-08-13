import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { listIntegrationAudit } from "@/lib/integrations/audit";

export const GET = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;
  const entries = await listIntegrationAudit(session.businessId, id);
  return NextResponse.json({ entries });
});
