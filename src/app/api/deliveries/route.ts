import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listDeliveries } from "@/lib/delivery-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/** Dispatch board: delivery orders and their courier/status. Active-only unless ?includeDone=true. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.deliveryManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ deliveries: [] });

  const includeDone = request.nextUrl.searchParams.get("includeDone") === "true";
  const deliveries = await listDeliveries(location.id, { includeDone });
  return NextResponse.json({ deliveries });
});
