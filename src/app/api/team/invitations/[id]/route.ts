import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { TeamError, revokeInvitation } from "@/lib/team-service";

/** Revokes a pending invitation, making its link stop working immediately. */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  const { id } = await context.params;
  try {
    await revokeInvitation(session.businessId, id, session.sub);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TeamError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
