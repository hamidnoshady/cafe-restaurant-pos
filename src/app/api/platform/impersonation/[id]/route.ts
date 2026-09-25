import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { closeSupportSession } from "@/lib/platform-service";
import { supportCloseMeta } from "@/lib/support-session";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Close an impersonation window.
 *
 *   - `?action=revoke` — a *different* admin pulls the plug on someone else's
 *     open grant: the kill switch. Needs `impersonate.revoke` (engineer/owner).
 *   - default — the admin ends their *own* window (they left the business).
 *     Any admin may end their own; the close is scoped to grants they hold.
 *
 * Either way the grant is stamped closed (and audited) by `closeSupportSession`,
 * so `activeGrant` stops returning it and the next request carrying the
 * matching `imp` claim is rejected by the tenant guard — ending a window takes
 * effect within one request, without waiting for the tenant token to expire.
 */
export const DELETE = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const revoke = request.nextUrl.searchParams.get("action") === "revoke";

  const guard = revoke ? await requirePlatformCapability("impersonate.revoke") : await requirePlatformAdmin();
  if (guard.error) return guard.error;
  const result = await closeSupportSession(
    id,
    revoke ? { type: "platform_admin", adminId: guard.session.padmin } : { type: "operator", adminId: guard.session.padmin },
    supportCloseMeta(request.headers, "platform_console"),
  );
  if (result.status === "not_active" || result.status === "expired") {
    return NextResponse.json({ error: "support_session_not_active" }, { status: 409 });
  }
  return NextResponse.json({ ok: true, sessionId: id, status: result.status });
});
