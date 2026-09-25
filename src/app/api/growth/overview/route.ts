import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { growthOverviewForSession } from "@/lib/growth-overview";

/**
 * The Growth & Marketing app's dashboard, in one call (Phase 36b). Read-only:
 * the app's writes stay where they already are — the loyalty/promotions/
 * commission services and their posting rules — so this endpoint can never
 * disagree with the ledger it reports the balances of.
 *
 * Owner/manager only: the overview carries commission (compensation) data, the
 * same reason the ledger's payroll tab is not for managers.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.growthView);
  if (error) return error;

  return NextResponse.json({ overview: await growthOverviewForSession(session) });
});
