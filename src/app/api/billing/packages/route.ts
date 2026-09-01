import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { listCreditPackages } from "@/lib/wallet-service";

/** Active top-up packages offered to the business on the billing page. */
export const GET = withTenantScope(async () => {
  const { error } = await requireRole("owner", "manager", "cashier", "waiter", "kitchen", "accountant");
  if (error) return error;
  return NextResponse.json({ packages: await listCreditPackages(true) });
});
