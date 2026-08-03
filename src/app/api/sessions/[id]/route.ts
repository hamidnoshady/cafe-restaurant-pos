import { NextResponse, type NextRequest } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { EmployeeError, revokeSession } from "@/lib/employee-service";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Ends an employee's active session from the admin side (Phase 20 Wave 7) —
 * e.g. a lost phone or a suspicious login the owner wants to cut off
 * immediately, without waiting for `SESSION_HOURS` to lapse. Reuses the same
 * `revokeSession` self-service logout already calls; `employee_sessions` is
 * only ever minted for PIN-role members (cashier/waiter/kitchen), so there is
 * no owner/manager session here to accidentally lock the caller out of.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;
  const { id } = await context.params;
  try {
    await revokeSession(id, session.businessId, session.sub);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof EmployeeError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
