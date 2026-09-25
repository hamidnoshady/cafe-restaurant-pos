import { NextResponse } from "next/server";
import { getSession, requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { computeSetupState, hasAnyUser } from "@/lib/setup-state";

/**
 * Aggregated wizard state. Public only to the extent of answering
 * "does this install need bootstrapping?" — everything else requires
 * an Owner/Manager session.
 */
export const GET = withTenantScope(async () => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ needsBootstrap: !(await hasAnyUser()) });
  }
  const guard = await requirePermission(PERMISSIONS.settingsManage);
  if (guard.error) return guard.error;
  const state = await computeSetupState(guard.session.businessId);
  return NextResponse.json(state);
});
