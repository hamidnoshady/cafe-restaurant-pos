import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { listCustomerBalances } from "@/lib/ar-service";

/** Every customer with a nonzero AR balance. Same access as the rest of the ledger surface. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  return NextResponse.json({ customers: await listCustomerBalances(session.businessId) });
});
