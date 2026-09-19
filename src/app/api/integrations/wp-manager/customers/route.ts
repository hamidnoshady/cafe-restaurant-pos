import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getConnection } from "@/lib/integrations/connections-service";
import { wpStoreCustomers } from "@/lib/integrations/wp-manager-service";

/** The customers mirrored from one store, joined to their local CRM record. */
export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId");
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10);
  const search = (url.searchParams.get("search") ?? "").trim().slice(0, 200);
  const connection = await getConnection(session.businessId, connectionId);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { customers, total, page: currentPage, pageSize: currentPageSize } = await wpStoreCustomers(
    session.businessId,
    connectionId,
    { page, pageSize, search },
  );
  return NextResponse.json({ customers, total, page: currentPage, pageSize: currentPageSize });
});
