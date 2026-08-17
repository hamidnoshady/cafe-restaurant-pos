import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { customersDueForRepurchase } from "@/lib/loyalty-service";

/** The «مشتریان آماده خرید مجدد» list for the caller's branch. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ customers: [] });

  const today = new Date().toISOString().slice(0, 10);
  const customers = await customersDueForRepurchase(session.businessId, location.id, today);
  return NextResponse.json({ customers });
});
