import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { TeamError, acceptInvitation, previewInvitation } from "@/lib/team-service";

function errorResponse(err: unknown): NextResponse {
  if (err instanceof TeamError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/**
 * What an invitation link is offering, before it is accepted.
 *
 * Public and session-less by necessity: the person following the link has no
 * account here yet, and by definition no membership of the business that
 * invited them. The token is the credential, and it is only ever exchanged for
 * the business name and the invited address — never for anything about the
 * business's data.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 400 });

  try {
    return NextResponse.json(await previewInvitation(token));
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Accepts an invitation and signs the new member in.
 *
 * A password is required only when this is the person's first business — if
 * the email already has a platform login, the existing identity is linked and
 * their current password continues to work unchanged.
 */
export async function POST(request: NextRequest) {
  let body: { token?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.token) return NextResponse.json({ error: "missing_token" }, { status: 400 });

  try {
    const result = await acceptInvitation(body.token, body.password ?? null);

    const token = await signSession({
      sub: result.userId,
      role: result.role,
      businessId: result.businessId,
      businessSlug: result.businessSlug,
      locationId: result.locationId,
      fullName: result.fullName,
      platformUserId: result.platformUserId,
    });

    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
