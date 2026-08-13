import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { testConnection } from "@/lib/integrations/connections-service";

export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const result = await testConnection(session.businessId, id);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.error === "not_found" ? 404 : 502 });
  return NextResponse.json({ ok: true });
});
