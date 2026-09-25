import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, withTenantScope, requireRole } from "@/lib/auth";
import { endImpersonation, getGrant, listGrants, tenantRevokeImpersonation } from "@/lib/platform-service";
import { platformAudit } from "@/lib/platform-auth";
import { query } from "@/lib/db";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "admin", "manager");
  if (error) return error;
  const policy = await query<{ support_access_policy: string }>("SELECT support_access_policy FROM businesses WHERE id = $1", [session.businessId]);
  return NextResponse.json({ grants: await listGrants(session.businessId), policy: policy.rows[0]?.support_access_policy ?? "standard" });
});

export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "admin");
  if (error) return error;
  const body = await request.json().catch(() => null) as { policy?: string } | null;
  if (!body || !["standard", "approval_required", "strict", "disabled"].includes(body.policy ?? "")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  await query("UPDATE businesses SET support_access_policy = $2 WHERE id = $1", [session.businessId, body.policy]);
  return NextResponse.json({ ok: true, policy: body.policy });
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "admin", "manager");
  if (error) return error;
  const grantId = session.imp?.grantId ?? request.nextUrl.searchParams.get("grantId");
  if (!grantId) return NextResponse.json({ error: "missing_grant" }, { status: 400 });

  const grant = await getGrant(grantId, session.businessId);
  if (!grant) return NextResponse.json({ error: "support_session_not_found" }, { status: 404 });
  const ended = session.imp
    ? await endImpersonation(grantId, session.imp.adminId)
    : await tenantRevokeImpersonation(grantId, session.businessId, session.sub);
  if (!ended) return NextResponse.json({ error: "support_session_not_active" }, { status: 409 });

  await platformAudit({
    adminId: grant.platformAdminId,
    businessId: session.businessId,
    action: session.imp ? "support_session.ended" : "support_session.tenant_revoked",
    entity: "impersonation_grant",
    entityId: grantId,
    payload: { endedByTenantUserId: session.imp ? null : session.sub },
  });
  const response = NextResponse.json({ ok: true, returnTo: `/platform/businesses/${session.businessId}/support` });
  if (session.imp) response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return response;
});
