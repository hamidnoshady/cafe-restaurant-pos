import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getTrialBalance } from "@/lib/ledger-reports-service";

/**
 * Trial balance. The query lives in `ledger-reports-service.ts` — shared with
 * the accounting dashboard, which is how the two can no longer disagree about
 * which accounts count (see that module's `ARCHIVED_WITH_POSTINGS` note).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  return NextResponse.json(await getTrialBalance(session.businessId));
});
