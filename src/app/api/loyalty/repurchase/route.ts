import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { businessToday } from "@/lib/business-day-service";
import { customersDueForRepurchase } from "@/lib/loyalty-service";

/** The «مشتریان آماده خرید مجدد» list for the caller's branch. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ customers: [] });

  // The business's own trading day, not the server's UTC date — around
  // midnight UTC the two differ by a day for a Tehran business, and a
  // customer's «موعد» flipped in and out of the list accordingly.
  const today = await businessToday(session.businessId);
  const customers = await customersDueForRepurchase(session.businessId, location.id, today);
  return NextResponse.json({ customers });
});
