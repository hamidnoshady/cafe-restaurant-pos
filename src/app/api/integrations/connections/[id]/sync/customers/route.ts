import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { syncCustomers } from "@/lib/integrations/sync-service";

export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  try {
    const outcome = await syncCustomers(session.businessId, id);
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    if ((err as Error).message === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
