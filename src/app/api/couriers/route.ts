import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createCourier, listCouriers } from "@/lib/delivery-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/** In-house couriers for delivery dispatch. Cashiers list them (to assign); managers/owners manage the roster. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.deliveryManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ couriers: [] });

  const askedForInactive = request.nextUrl.searchParams.get("includeInactive") === "true";
  const configureGuard = askedForInactive ? await requirePermission(PERMISSIONS.deliveryConfigure) : null;
  if (configureGuard?.error) return configureGuard.error;
  const includeInactive = askedForInactive;
  const couriers = await listCouriers(location.id, { includeInactive });
  return NextResponse.json({ couriers });
});

interface CreateCourierBody {
  name?: string;
  phone?: string;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.deliveryConfigure);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: CreateCourierBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await createCourier(location.id, { name: body.name ?? "", phone: body.phone ?? null });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, courier: result.data });
});
