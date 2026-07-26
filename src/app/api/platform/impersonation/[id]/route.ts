import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  platformAudit,
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
export async function DELETE(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const action = request.nextUrl.searchParams.get("action");

  if (action === "revoke") {
    const { session, error } = await requirePlatformCapability("impersonate.revoke");
    if (error) return error;
    await revokeImpersonation(id, session.padmin);
    await platformAudit({
      adminId: session.padmin,
      action: "impersonation.revoke",
      entity: "impersonation_grant",
      entityId: id,
    });
    return NextResponse.json({ ok: true });
  }

  const { session, error } = await requirePlatformAdmin();
  if (error) return error;
  await endImpersonation(id, session.padmin);
  await platformAudit({
    adminId: session.padmin,
    action: "impersonation.end",
    entity: "impersonation_grant",
    entityId: id,
  });
  return NextResponse.json({ ok: true });
}
