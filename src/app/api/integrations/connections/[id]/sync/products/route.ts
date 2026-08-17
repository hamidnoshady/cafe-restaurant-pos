import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getConnection } from "@/lib/integrations/connections-service";
import { enqueuePluginExport } from "@/lib/integrations/plugin-service";
import { syncProducts } from "@/lib/integrations/sync-service";

/**
 * "Sync products now", in whichever direction this connection runs.
 *
 * In `rest_api` mode the app pulls the catalogue itself. In `plugin` mode it
 * cannot — it holds no credentials for the store — so the button enqueues a
 * job and the catalogue arrives as ordinary product events the next time the
 * plugin runs. Same button, same outcome, different mechanics; the response
 * says which happened so the panel can word it honestly.
 */
export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const connection = await getConnection(session.businessId, id);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (connection.link_mode === "plugin") {
    await enqueuePluginExport(session.businessId, id, "catalogue_export");
    return NextResponse.json({ ok: true, queued: true });
  }

  try {
    const outcome = await syncProducts(session.businessId, id);
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    if ((err as Error).message === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
