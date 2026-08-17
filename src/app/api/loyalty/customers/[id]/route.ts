import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getCustomer } from "@/lib/customers-service";
import { pointsBalance, storeCreditBalance } from "@/lib/loyalty-service";

/** One customer's points and store-credit balances — both reconstructed, never stored. */
export const GET = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const { id } = await context.params;

  const customer = await getCustomer(session.businessId, id);
  if (!customer) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });

  const [points, credit] = await Promise.all([
    pointsBalance(session.businessId, id),
    storeCreditBalance(session.businessId, id),
  ]);
  return NextResponse.json({ points, storeCredit: credit });
});
