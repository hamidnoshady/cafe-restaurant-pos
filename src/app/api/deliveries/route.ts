import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { listDeliveries } from "@/lib/delivery-service";
import { getPrimaryLocation } from "@/lib/setup-state";

/** Dispatch board: delivery orders and their courier/status. Active-only unless ?includeDone=true. */
export async function GET(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ deliveries: [] });

  const includeDone = request.nextUrl.searchParams.get("includeDone") === "true";
  const deliveries = await listDeliveries(location.id, { includeDone });
  return NextResponse.json({ deliveries });
}
