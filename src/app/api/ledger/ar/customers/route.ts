import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listCustomerBalances, listCustomerDirectory } from "@/lib/ar-service";

/**
 * `?scope=directory` → every customer record with its balance (what a picker
 * needs); default → only customers with a nonzero A/R balance, plus the
 * unattributed bucket (what the A/R report shows).
 *
 * They were one list, and every picker in the ledger was therefore limited to
 * customers who already owed money and could also offer the unattributed
 * bucket — whose id is the sentinel `"unknown"`, not a uuid. Same access as the
 * rest of the ledger surface either way.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  if (request.nextUrl.searchParams.get("scope") === "directory") {
    return NextResponse.json({ customers: await listCustomerDirectory(session.businessId) });
  }
  return NextResponse.json({ customers: await listCustomerBalances(session.businessId) });
});
