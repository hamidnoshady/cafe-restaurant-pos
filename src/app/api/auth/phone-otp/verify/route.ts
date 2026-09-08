import { NextRequest, NextResponse } from "next/server";
import { query, withTenant } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "@/lib/auth";
import { resolveDeviceId } from "@/lib/device-service";
import {
  auditLoginFailure,
  checkLoginLockout,
  createSession,
  ensureEmployeeProfile,
} from "@/lib/employee-service";
import { stampPhoneVerified, verifyEmployeePhoneOtp, verifyPhonePendingToken } from "@/lib/phone-otp";

interface MemberRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  business_slug: string;
  business_subdomain: string;
  location_id: string | null;
  role: Role;
  full_name: string;
  platform_user_id: string | null;
  token_version: number | null;
}

/**
 * Phase 42 — the second half of the phone-OTP door: check the code, and on
 * success mint exactly the session `pin-login` would have (employee_sessions
 * row + JWT cookie), so everything downstream — revocation re-checks, app
 * gating, the lot — treats a phone login and a PIN login identically.
 *
 * A correct code does three things at once: it proves possession of the
 * number (the login), it stamps `phone_verified_at` the first time (the
 * first-time verification), and it re-opens the 7-day PIN window
 * (`otp_login_at`) — one write, because they all become true together.
 *
 * A wrong code is audited and counted against the employee lockout the PIN
 * failures share (`invalid_phone_otp`): five wrong guesses of *either* kind
 * pause the door for that member.
 */
export async function POST(request: NextRequest) {
  let body: { code?: string; deviceToken?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await verifyPhonePendingToken(bearer);
  if (!payload) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const code = body.code ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  }

  // The anti-enumeration token from a number nothing matched: no subject, no
  // challenge, and the only honest answer is the one a wrong code gets.
  if (!payload.sub) {
    return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  }

  return withTenant(payload.businessId, async () => {
    const lockout = await checkLoginLockout(payload.businessId, payload.sub!);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    const ok = await verifyEmployeePhoneOtp({ userId: payload.sub!, code });
    if (!ok) {
      await auditLoginFailure(payload.businessId, payload.sub!, "invalid_phone_otp");
      return NextResponse.json({ error: "invalid_code" }, { status: 401 });
    }

    const { rows } = await query<MemberRow>(
      `SELECT u.id, u.business_id, b.slug::text AS business_slug,
              b.subdomain::text AS business_subdomain, u.location_id,
              u.role, u.full_name, u.platform_user_id, p.token_version
         FROM users u
         JOIN businesses b ON b.id = u.business_id
         LEFT JOIN platform_users p ON p.id = u.platform_user_id
        WHERE u.id = $1 AND u.business_id = $2 AND u.is_active AND b.status = 'active'`,
      [payload.sub, payload.businessId],
    );
    const member = rows[0];
    if (!member) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    // The one write that makes all three facts true together — verified
    // number, fresh OTP window, and (first-time flow) the number itself.
    await stampPhoneVerified({
      businessId: payload.businessId,
      userId: member.id,
      phone: payload.mayAttachPhone ? (payload.phone ?? null) : null,
    });

    await ensureEmployeeProfile(member.id, member.business_id);
    const deviceLabel = request.headers.get("user-agent")?.slice(0, 120) ?? null;
    const deviceId = await resolveDeviceId(body.deviceToken, member.business_id);
    const { session: employeeSession } = await createSession(member.id, member.business_id, {
      locationId: member.location_id,
      deviceLabel,
      deviceId,
    });

    const token = await signSession({
      sub: member.id,
      role: member.role,
      businessId: member.business_id,
      businessSlug: member.business_slug,
      businessSubdomain: member.business_subdomain,
      locationId: member.location_id,
      fullName: member.full_name,
      // Admin roles hold a platform identity; carrying it (with the live token
      // version, exactly like /api/auth/login does) keeps a phone login by an
      // owner or manager the same session a password login would have minted.
      platformUserId: member.platform_user_id,
      tokenVersion: member.token_version ?? undefined,
      employeeSessionId: employeeSession.id,
    });

    const res = NextResponse.json({
      user: { id: member.id, role: member.role, fullName: member.full_name },
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  });
}
