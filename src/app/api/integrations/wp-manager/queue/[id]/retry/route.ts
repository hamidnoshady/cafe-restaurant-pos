import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getConnection } from "@/lib/integrations/connections-service";
import { retryWpQueueRow } from "@/lib/integrations/wp-manager-service";

/** Put a failed or dead WP queue row (outbox or inbox) back in the queue, due now. */
export const POST = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const { id } = await context.params;
  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId");
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });

  const connection = await getConnection(session.businessId, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await retryWpQueueRow(session.businessId, connectionId, id);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error ?? "retry_failed" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, status: result.status });
});
