import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listAuditLog } from "@/lib/audit-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One account's change history (issue #160 §7.5, Phase 22 Wave 11) — every
 * rename/reparent/archive/reactivate, who did it and when. Reuses the
 * existing `audit_log` table (Phase 0/20) via listAuditLog's `entityId`
 * filter rather than a dedicated accounts-history table; same
 * `accounts.edit` gate the mutating PATCH/DELETE routes already use, so
 * only whoever could have made these changes can review them.
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  const { id } = await ctx.params;
  const entries = await listAuditLog(session.businessId, { entity: "account", entityId: id, limit: 100 });
  return NextResponse.json({ entries });
});
