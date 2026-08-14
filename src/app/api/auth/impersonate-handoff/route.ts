import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { hostRoutingEnabled, parseHost, preferredProto, requestHost, rootDomain } from "@/lib/host";
import { redeemImpersonationHandoff } from "@/lib/platform-service";

const ERROR_STATUS: Record<string, number> = {
  invalid: 400,
  expired: 400,
  used: 409,
  grant_inactive: 409,
};

/**
 * Phase 23 follow-up — the business-origin half of entering a business.
 *
 * The console's impersonate route (admin.{root}) writes the grant and hands the
 * browser a one-time URL here; the browser lands on the business's own origin
 * and presents the token, which is what mints the tenant session on the host
 * where the host-scoped cookie actually belongs.
 *
 * Session-less by necessity: the visitor has no session on this origin yet —
 * the whole point of the token is to mint the first one. The token is the
 * credential, exactly like /api/auth/accept-invite's, and like that one it is
 * short-lived and single-use (enforced by a row lock in
 * `redeemImpersonationHandoff`, never trusted from the URL alone).
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 400 });

  const result = await redeemImpersonationHandoff(token);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: ERROR_STATUS[result.error] ?? 400 },
    );
  }

  // The minted cookie is host-scoped, so it is only usable on the origin that
  // serves this business. Redeeming anywhere else (the console, the apex, a
  // neighbour business) would mint a cookie middleware bounces on the very next
  // navigation — refuse here instead, so a misdelivered or replayed token fails
  // at the point of use rather than somewhere confusing.
  if (hostRoutingEnabled()) {
    const host = parseHost(requestHost(request.headers), rootDomain());
    if (host.kind !== "business" || host.label !== result.businessSubdomain) {
      return NextResponse.json({ error: "wrong_origin" }, { status: 400 });
    }
  }

  const sessionToken = await signSession({
    sub: result.userId,
    role: "owner",
    businessId: result.businessId,
    businessSlug: result.businessSlug,
    businessSubdomain: result.businessSubdomain,
    locationId: null,
    fullName: result.fullName,
    imp: { grantId: result.grantId, adminId: result.adminId, mode: result.mode },
  });

  // The redirect target is built from the Host header, not `request.url`: inside
  // a route handler `request.url` is the *internal* origin (see
  // /api/host/redirect), which the browser cannot reach behind a proxy.
  const hostHeader = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = preferredProto(request.headers.get("x-forwarded-proto"), request.nextUrl.protocol);
  const res = NextResponse.redirect(`${proto}://${hostHeader}/dashboard`);
  res.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieOptions());
  return res;
}
