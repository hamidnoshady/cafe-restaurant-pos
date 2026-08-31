import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getConnection } from "@/lib/integrations/connections-service";
import { wpStoreCustomers } from "@/lib/integrations/wp-manager-service";

/** The customers mirrored from one store, joined to their local CRM record. */
export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const connectionId = new URL(request.url).searchParams.get("connectionId");
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  const connection = await getConnection(session.businessId, connectionId);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const customers = await wpStoreCustomers(session.businessId, connectionId);
  return NextResponse.json({ customers });
});
