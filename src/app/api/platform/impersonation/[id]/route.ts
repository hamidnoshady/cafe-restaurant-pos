import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  platformAudit,
  withPlatformScope,
} from "@/lib/platform-auth";
import { endImpersonation, revokeImpersonation } from "@/lib/platform-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Close an impersonation window.
 *
 *   - `?action=revoke` — a *different* admin pulls the plug on someone else's
 *     open grant: the kill switch. Needs `impersonate.revoke` (engineer/owner).
 *   - default — the admin ends their *own* window (they left the business).
 *     Any admin may end their own.
 *
 * Either way the grant is stamped closed, so `activeGrant` stops returning it
 * and the next request carrying the matching `imp` claim is rejected by the
 * tenant guard — ending a window takes effect within one request, without
 * waiting for the tenant token to expire.
 */
export const DELETE = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const action = request.nextUrl.searchParams.get("action");

  if (action === "revoke") {
    const { session, error } = await requirePlatformCapability("impersonate.revoke");
    if (error) return error;
    const changed = await revokeImpersonation(id, session.padmin);
    if (!changed) return NextResponse.json({ error: "support_session_not_active" }, { status: 409 });
    await platformAudit({
      adminId: session.padmin,
      action: "support_session.revoked",
      entity: "impersonation_grant",
      entityId: id,
    });
    return NextResponse.json({ ok: true });
  }

  const { session, error } = await requirePlatformAdmin();
  if (error) return error;
  const changed = await endImpersonation(id, session.padmin);
  if (!changed) return NextResponse.json({ error: "support_session_not_active" }, { status: 409 });
  await platformAudit({
    adminId: session.padmin,
    action: "support_session.ended",
    entity: "impersonation_grant",
    entityId: id,
  });
  return NextResponse.json({ ok: true });
});
