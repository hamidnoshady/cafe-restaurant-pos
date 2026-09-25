import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deleteConnection, updateConnection } from "@/lib/integrations/connections-service";

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await updateConnection(session.businessId, id, {
    name: typeof body.name === "string" ? body.name : undefined,
    locationId: typeof body.locationId === "string" ? body.locationId : body.locationId === null ? null : undefined,
    status: body.status === "active" || body.status === "paused" ? body.status : undefined,
    syncOrders: typeof body.syncOrders === "boolean" ? body.syncOrders : undefined,
    syncProducts: typeof body.syncProducts === "boolean" ? body.syncProducts : undefined,
    syncCustomers: typeof body.syncCustomers === "boolean" ? body.syncCustomers : undefined,
    pushStock: typeof body.pushStock === "boolean" ? body.pushStock : undefined,
    pushPrices: typeof body.pushPrices === "boolean" ? body.pushPrices : undefined,
    syncCategories: typeof body.syncCategories === "boolean" ? body.syncCategories : undefined,
    autoPullOrders: typeof body.autoPullOrders === "boolean" ? body.autoPullOrders : undefined,
    orderLookbackDays: typeof body.orderLookbackDays === "number" ? body.orderLookbackDays : undefined,
    consumerKey: typeof body.consumerKey === "string" && body.consumerKey ? body.consumerKey : undefined,
    consumerSecret: typeof body.consumerSecret === "string" && body.consumerSecret ? body.consumerSecret : undefined,
    wpUsername: typeof body.wpUsername === "string" && body.wpUsername ? body.wpUsername : undefined,
    wpApplicationPassword:
      typeof body.wpApplicationPassword === "string" && body.wpApplicationPassword ? body.wpApplicationPassword : undefined,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  return NextResponse.json({ connection: result.connection });
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;

  const deleted = await deleteConnection(session.businessId, id);
  if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
