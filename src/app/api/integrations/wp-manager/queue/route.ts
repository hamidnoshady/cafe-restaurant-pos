import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getConnection } from "@/lib/integrations/connections-service";
import { wpQueue } from "@/lib/integrations/wp-manager-service";

/**
 * The operational queue for one connection: outbound outbox jobs (stock,
 * prices, product/order operations, export requests) that are pending/failed/
 * dead, plus inbound events that failed to apply. The manager's «صف و
 * رویدادها» section reads this so «چرا این سفارش نیامد؟» has one place to look.
 */
export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const connectionId = new URL(request.url).searchParams.get("connectionId");
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  const connection = await getConnection(session.businessId, connectionId);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const rows = await wpQueue(session.businessId, connectionId);
  return NextResponse.json({ rows });
});
