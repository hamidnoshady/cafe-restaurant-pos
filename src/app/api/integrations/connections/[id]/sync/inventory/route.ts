import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getConnection } from "@/lib/integrations/connections-service";
import { drainOutbox, refreshOutboxForConnection } from "@/lib/integrations/outbox-service";

export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const connection = await getConnection(session.businessId, id);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    await refreshOutboxForConnection(connection);
    await drainOutbox(connection);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
