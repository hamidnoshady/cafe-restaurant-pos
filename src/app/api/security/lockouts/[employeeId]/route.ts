import { NextResponse, type NextRequest } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { EmployeeError, clearLoginLockout } from "@/lib/employee-service";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Ends a lockout early (Phase 20 Wave 8) — an owner/manager vouching for the
 * employee (confirmed by phone, say) rather than waiting out
 * LOGIN_LOCKOUT_WINDOW_MINUTES. Writes the same `employee.login_unlocked`
 * audit row that resets the streak for both checkLoginLockout (the login
 * routes) and listLockedEmployees (this tab's own list).
 */
export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ employeeId: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.teamManage);
    if (error) return error;
    const { employeeId } = await context.params;
    try {
      await clearLoginLockout(session.businessId, employeeId, session.sub);
      return NextResponse.json({ ok: true });
    } catch (err) {
      if (err instanceof EmployeeError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  },
);
