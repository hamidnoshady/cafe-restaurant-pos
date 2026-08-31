import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { wpOverviewStats } from "@/lib/integrations/wp-manager-service";

/**
 * The WP Manager میز کار counts: connections, mirrored catalogue/orders/
 * customers/terms/content, and the operational queue. Business-scoped — the
 * same total an owner with several stores sees summed across them.
 */
export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const connectionId = new URL(request.url).searchParams.get("connectionId");
  const stats = await wpOverviewStats(session.businessId, connectionId);
  return NextResponse.json({ stats });
});
