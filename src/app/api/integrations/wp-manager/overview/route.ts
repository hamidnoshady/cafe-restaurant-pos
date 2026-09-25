import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getConnection } from "@/lib/integrations/connections-service";
import { wpOverviewStats } from "@/lib/integrations/wp-manager-service";

/**
 * The WP Manager میز کار counts: connections, mirrored catalogue/orders/
 * customers/terms/content, and the operational queue. Business-scoped — the
 * same total an owner with several stores sees summed across them.
 */
export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.websiteView);
  if (error) return error;

  const connectionId = new URL(request.url).searchParams.get("connectionId");
  if (connectionId) {
    const connection = await getConnection(session.businessId, connectionId);
    if (!connection || connection.provider !== "woocommerce") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
  }
  const stats = await wpOverviewStats(session.businessId, connectionId);
  return NextResponse.json({ stats });
});
