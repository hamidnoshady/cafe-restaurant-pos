import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getWallet, listLedger } from "@/lib/wallet-service";

/**
 * The business's wallet — balance, lifetime totals, and recent ledger entries.
 * Read by the small credit badge in the dashboard chrome (balance only) and
 * the billing page (full ledger). Any signed-in member may see the balance;
 * spending decisions are always made server-side regardless.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;

  const [wallet, ledger] = await Promise.all([
    getWallet(session.businessId),
    listLedger(session.businessId, 50),
  ]);

  return NextResponse.json({ wallet, ledger });
});
