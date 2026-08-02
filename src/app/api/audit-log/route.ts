import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { listAuditLog } from "@/lib/audit-service";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Phase 20 Wave 6 — the audit trail's admin review tab. Gated the same way
 * shift history (Wave 5) is: `team.manage`, the permission an owner/manager
 * already needs to force-reset a PIN or force-close a shift, since reviewing
 * every employee/session/device/shift security event is the same kind of
 * "act on this business's security state" concern. Business-wide, across
 * every branch, like `/api/devices` and `/api/shifts` already are.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const before = searchParams.get("before");
  const entries = await listAuditLog(session.businessId, {
    entity: searchParams.get("entity") ?? undefined,
    actorId: searchParams.get("actorId") ?? undefined,
    action: searchParams.get("action") ?? undefined,
    before: before ? Number(before) : undefined,
    limit: searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined,
  });
  return NextResponse.json({ entries });
});
