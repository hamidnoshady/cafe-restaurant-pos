import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getBusinessDayStatus } from "@/lib/business-day-service";
import { customersDueForRepurchase } from "@/lib/loyalty-service";

/** The «مشتریان آماده خرید مجدد» list for the caller's branch. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.loyaltyView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ customers: [] });

  const businessDay = await getBusinessDayStatus(location.id);
  const customers = await customersDueForRepurchase(
    session.businessId,
    location.id,
    businessDay?.businessDate ?? new Date().toISOString().slice(0, 10),
  );
  return NextResponse.json({ customers });
});
