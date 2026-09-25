import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { NextRequest, NextResponse } from "next/server";
import {requirePermission, withTenantScope } from "@/lib/auth";
import { createCourier, listCouriers } from "@/lib/delivery-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/** In-house couriers for delivery dispatch. Cashiers list them (to assign); managers/owners manage the roster. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.deliveryManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ couriers: [] });

  // `delivery.manage` is what maintaining the courier roster is. This is a
  // deliberate, documented widening: a cashier already holds `delivery.manage`
  // and already assigns couriers, so letting them also *see the retired ones*
  // in the same picker is the capability working as named rather than a new
  // privilege. Nothing sensitive is behind the flag — it is the same rows with
  // `is_active = false`.
  const access = await memberAccessFor(session);
  const includeInactive =
    (access?.permissions.has(PERMISSIONS.deliveryManage) ?? false) &&
    request.nextUrl.searchParams.get("includeInactive") === "true";
  const couriers = await listCouriers(location.id, { includeInactive });
  return NextResponse.json({ couriers });
});

interface CreateCourierBody {
  name?: string;
  phone?: string;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
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
