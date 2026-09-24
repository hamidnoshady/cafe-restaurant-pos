import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getCustomer } from "@/lib/parties-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getBusinessDayStatus } from "@/lib/business-day-service";
import { pointsBalance, storeCreditBalance } from "@/lib/loyalty-service";

/** One customer's points and store-credit balances — both reconstructed, never stored. */
export const GET = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.loyaltyView);
  if (error) return error;
  const { id } = await context.params;

  const customer = await getCustomer(session.businessId, id);
  if (!customer) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });

  const location = await resolveActiveLocation(session);
  const businessDay = location ? await getBusinessDayStatus(location.id) : null;
  const [points, credit] = await Promise.all([
    pointsBalance(session.businessId, id, undefined, businessDay?.businessDate),
    storeCreditBalance(session.businessId, id),
  ]);
  return NextResponse.json({ points, storeCredit: credit });
});
