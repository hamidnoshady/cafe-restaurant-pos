import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { listLockedEmployees } from "@/lib/employee-service";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Phase 20 Wave 8 — the security center's "who is currently locked out of
 * login" list, resolving this phase's Wave 7 open question 2: a run of
 * repeated failed attempts now does something beyond being visible
 * (LOGIN_LOCKOUT_THRESHOLD of them within LOGIN_LOCKOUT_WINDOW_MINUTES blocks
 * further attempts — see employee.ts's lockoutStatus). Same `team.manage`
 * gate as active sessions and the audit log.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;
  const lockouts = await listLockedEmployees(session.businessId);
  return NextResponse.json({ lockouts });
});
