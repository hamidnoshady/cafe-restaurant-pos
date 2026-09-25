import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listCreditPackages } from "@/lib/wallet-service";

/** Active top-up packages offered to the business on the billing page. */
export const GET = withTenantScope(async () => {
  const { error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;
  return NextResponse.json({ packages: await listCreditPackages(true) });
});
