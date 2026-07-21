import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { getPrimaryLocation } from "@/lib/setup-state";

/** Business/location name + contact info for the printed receipt header — every role that can check out an order needs it, not just managers (unlike /api/setup/business). */
export async function GET() {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter", "kitchen");
  if (error) return error;

  const { rows } = await query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [session.businessId]);
  const location = await getPrimaryLocation(session.businessId);

  return NextResponse.json({
    name: rows[0]?.name ?? "",
    address: location?.address ?? null,
    phone: location?.phone ?? null,
  });
}
