import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getConnection, wooClientFor } from "@/lib/integrations/connections-service";
import { enqueueContentExport, listWpContent, syncWpContentRest } from "@/lib/integrations/wp-content-service";

/**
 * WordPress content (posts/pages/media) mirrored for one connection.
 *
 * GET reads the local mirror — identical for both link modes. POST is
 * «همگام‌سازی محتوا»: in plugin mode it queues a `content_export` job the
 * plugin applies on its next pull (the app has no store credentials there);
 * in REST mode it reads wp/v2 directly with the WooCommerce consumer keys.
 */
export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId");
  const type = url.searchParams.get("type");
  const search = url.searchParams.get("search");
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  const connection = await getConnection(session.businessId, connectionId);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const rows = await listWpContent(session.businessId, connectionId, {
    wpType: type ?? undefined,
    search: search ?? undefined,
  });
  return NextResponse.json({ rows, syncedAt: connection.last_content_sync_at });
});

export const POST = withTenantScope(async (request: Request) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { connectionId?: string; action?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  const connection = await getConnection(session.businessId, body.connectionId);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (connection.link_mode === "plugin") {
    await enqueueContentExport(session.businessId, body.connectionId);
    return NextResponse.json({ ok: true, queued: true });
  }

  try {
    const client = wooClientFor(connection);
    const outcome = await syncWpContentRest(connection, client);
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
