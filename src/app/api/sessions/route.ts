import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { listActiveSessionsForBusiness } from "@/lib/employee-service";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Phase 20 Wave 7 — the security center's "who is currently signed in, on
 * which device" list. Business-wide, across every branch, gated the same way
 * shift history and the audit trail are (`team.manage` — the permission an
 * owner/manager already needs to force-reset a PIN or force-close a shift;
 * reviewing or ending someone else's active session is the same kind of
 * "act on this business's security state" concern).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;
  const sessions = await listActiveSessionsForBusiness(session.businessId);
  return NextResponse.json({ sessions });
});
