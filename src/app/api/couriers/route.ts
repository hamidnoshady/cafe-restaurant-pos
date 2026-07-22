import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createCourier, listCouriers } from "@/lib/delivery-service";
import { getPrimaryLocation } from "@/lib/setup-state";

/** In-house couriers for delivery dispatch. Cashiers list them (to assign); managers/owners manage the roster. */
export async function GET(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ couriers: [] });

  const includeInactive =
    (session.role === "owner" || session.role === "manager") &&
    request.nextUrl.searchParams.get("includeInactive") === "true";
  const couriers = await listCouriers(location.id, { includeInactive });
  return NextResponse.json({ couriers });
}

interface CreateCourierBody {
  name?: string;
  phone?: string;
}

export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await getPrimaryLocation(session.businessId);
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
}
