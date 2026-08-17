import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getConnection } from "@/lib/integrations/connections-service";
import { enqueuePluginExport } from "@/lib/integrations/plugin-service";
import { syncCustomers } from "@/lib/integrations/sync-service";

/** The customer twin of the products route — see it for why plugin mode queues rather than pulls. */
export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const connection = await getConnection(session.businessId, id);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (connection.link_mode === "plugin") {
    await enqueuePluginExport(session.businessId, id, "customer_export");
    return NextResponse.json({ ok: true, queued: true });
  }

  try {
    const outcome = await syncCustomers(session.businessId, id);
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    if ((err as Error).message === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
