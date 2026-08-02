import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listShifts } from "@/lib/shift-service";

/**
 * Shift history for the admin review tab (Phase 20 Wave 5) — gated the same
 * way the rest of staff administration is (`team.manage`, the permission the
 * PIN/password reset route already requires for acting on someone else's
 * credentials), since reviewing a shift is the same kind of "manage this
 * employee" action.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const shifts = await listShifts(session.businessId, {
    employeeId: searchParams.get("employeeId") ?? undefined,
    locationId: searchParams.get("locationId") ?? undefined,
  });
  return NextResponse.json({ shifts });
});
