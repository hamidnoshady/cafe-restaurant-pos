import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, supportSessionClaims, withTenantScope, requireRole } from "@/lib/auth";
import { closeSupportSession, listGrants } from "@/lib/platform-service";
import { query } from "@/lib/db";
import { supportCloseMeta, supportSessionReturnPath, type SupportSessionEndResponse } from "@/lib/support-session";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "admin", "manager");
  if (error) return error;
  const policy = await query<{ support_access_policy: string }>("SELECT support_access_policy FROM businesses WHERE id = $1", [session.businessId]);
  return NextResponse.json({ grants: await listGrants(session.businessId), policy: policy.rows[0]?.support_access_policy ?? "standard" });
});

export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "admin");
  if (error) return error;
  // The policy is the business's own control over support access; the
  // operator it constrains must not be able to loosen it from inside a session.
  if (session.imp) return NextResponse.json({ error: "support_policy_owner_only" }, { status: 403 });
  const body = await request.json().catch(() => null) as { policy?: string } | null;
  if (!body || !["standard", "approval_required", "strict", "disabled"].includes(body.policy ?? "")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  await query("UPDATE businesses SET support_access_policy = $2 WHERE id = $1", [session.businessId, body.policy]);
  return NextResponse.json({ ok: true, policy: body.policy });
});

/**
 * Two callers, told apart by the cookie rather than by anything in the request:
 *
 *   - the support operator leaving (the banner's «پایان نشست»): closes the grant
 *     named in their own signed token and clears the tenant cookie. Idempotent —
 *     an already-ended, revoked or expired session still gets its cookie cleared
 *     and a way back to the console, so the operator is never trapped. The
 *     optional `grantId` is only a guard: a stale tab naming an older session
 *     must not end the newer one this browser now holds.
 *   - the business's owner/admin/manager revoking one grant from the security
 *     settings page, by `grantId`, scoped to their own business.
 */
export const DELETE = withTenantScope(async (request: NextRequest) => {
  const expectedGrantId = request.nextUrl.searchParams.get("grantId");
  const support = await supportSessionClaims();

  if (support) {
    if (expectedGrantId && expectedGrantId !== support.imp.grantId) {
      return NextResponse.json({ error: "support_session_mismatch" }, { status: 409 });
    }
    const result = await closeSupportSession(
      support.imp.grantId,
      { type: "operator", adminId: support.imp.adminId, businessId: support.businessId },
      supportCloseMeta(request.headers, "tenant_banner"),
    );
    const body: SupportSessionEndResponse = {
      ok: true,
      sessionId: support.imp.grantId,
      status: result.status,
      redirectTo: supportSessionReturnPath(support.businessId),
    };
    const response = NextResponse.json(body);
    response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
    return response;
  }

  const { session, error } = await requireRole("owner", "admin", "manager");
  if (error) return error;
  if (!expectedGrantId) return NextResponse.json({ error: "missing_grant" }, { status: 400 });
  const result = await closeSupportSession(
    expectedGrantId,
    { type: "tenant_admin", userId: session.sub, businessId: session.businessId },
    supportCloseMeta(request.headers, "tenant_settings"),
  );
  if (result.status !== "revoked") return NextResponse.json({ error: "support_session_not_active" }, { status: 409 });
  return NextResponse.json({ ok: true, sessionId: expectedGrantId, status: result.status });
});
