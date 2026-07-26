import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, getSession, sessionCookieOptions, signSession, withTenantScope } from "@/lib/auth";
import { withoutTenantScope } from "@/lib/db";
import { membershipBlockedReason, membershipForBusiness } from "@/lib/memberships";

/**
 * Move the current session to another of this person's businesses.
 *
 * Re-issues the session cookie against the target membership, so the caller's
 * role, default branch and — through `getSession()` — the tenant scope every
 * subsequent query runs under all change together. No re-authentication is
 * needed: the person already proved who they are, and the membership lookup
 * below is what proves they belong to the business they asked for.
 *
 * A PIN-only member has no platform identity and so has nothing to switch to.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!session.platformUserId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { businessId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.businessId) {
    return NextResponse.json({ error: "missing_business" }, { status: 400 });
  }

  const membership = await withoutTenantScope("login", () =>
    membershipForBusiness(session.platformUserId as string, body.businessId as string),
  );

  // Not a member, or the membership is inactive — the same answer either way,
  // so this can't be used to probe which businesses exist.
  if (!membership) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const blocked = membershipBlockedReason(membership);
  if (blocked) {
    return NextResponse.json({ error: "business_unavailable", reason: blocked }, { status: 403 });
  }

  const token = await signSession({
    sub: membership.userId,
    role: membership.role,
    businessId: membership.businessId,
    locationId: membership.locationId,
    fullName: membership.fullName,
    platformUserId: session.platformUserId,
  });

  const res = NextResponse.json({
    user: { id: membership.userId, role: membership.role, fullName: membership.fullName },
    business: {
      id: membership.businessId,
      name: membership.businessName,
      slug: membership.businessSlug,
    },
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
});
