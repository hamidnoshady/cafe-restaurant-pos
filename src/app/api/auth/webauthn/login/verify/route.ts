import { NextRequest, NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { query, withTenant } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "@/lib/auth";
import {
  completeWebauthnAuthentication,
  createSession,
  resolveLoginBusinessId,
} from "@/lib/employee-service";

interface UserRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  business_slug: string;
  location_id: string | null;
  role: Role;
  full_name: string;
}

/**
 * Step 2 of a biometric login — verifies the signed assertion and, on
 * success, mints an `employee_sessions` row plus the same JWT `pin-login`
 * would (`employeeSessionId` included, `checkEmployeeSession` re-checks it
 * live exactly as it does for a PIN login — biometric is a different way to
 * prove identity, not a different kind of session).
 */
export async function POST(request: NextRequest) {
  let body: {
    employeeId?: string;
    response?: AuthenticationResponseJSON;
    challengeToken?: string;
    businessId?: string;
    businessSlug?: string;
    locationId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.employeeId || !body.response || !body.challengeToken) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { businessId, error } = await resolveLoginBusinessId(body);
  if (!businessId) {
    return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
  }

  return withTenant(businessId, async () => {
    const result = await completeWebauthnAuthentication(
      body.employeeId!,
      businessId,
      body.response!,
      body.challengeToken!,
    );
    if (!result) {
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const { rows } = await query<UserRow>(
      `SELECT u.id, u.business_id, b.slug::text AS business_slug, u.location_id, u.role, u.full_name
         FROM users u
         JOIN businesses b ON b.id = u.business_id
        WHERE u.id = $1 AND u.is_active AND u.role IN ('cashier', 'waiter', 'kitchen')`,
      [body.employeeId],
    );
    const user = rows[0];
    if (!user) {
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const deviceLabel = request.headers.get("user-agent")?.slice(0, 120) ?? null;
    const { session: employeeSession } = await createSession(user.id, user.business_id, {
      locationId: user.location_id,
      credentialId: result.credentialId,
      deviceLabel,
    });

    const token = await signSession({
      sub: user.id,
      role: user.role,
      businessId: user.business_id,
      businessSlug: user.business_slug,
      locationId: user.location_id,
      fullName: user.full_name,
      platformUserId: null,
      employeeSessionId: employeeSession.id,
    });

    const res = NextResponse.json({
      user: { id: user.id, role: user.role, fullName: user.full_name },
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  });
}
