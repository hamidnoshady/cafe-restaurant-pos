import { NextRequest, NextResponse } from "next/server";
import { verifyMfaPendingToken, getAccountMfaEnrolments } from "@/lib/mfa-service";
import { verifyMfaCode } from "@/lib/mfa-verify";
import { countRemainingRecoveryCodes } from "@/lib/mfa-recovery";
import { query, withoutTenantScope } from "@/lib/db";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { membershipsForPlatformUser } from "@/lib/memberships";

/**
 * Second-factor verification for the tenant password realm — the step that
 * turns an `mfa_pending` token into a real session.
 *
 * Accepts either the enrolled factor's code, or (with `useRecoveryCode`) one of
 * the ten single-use codes issued at enrolment. The recovery path is what makes
 * a lost phone a bad afternoon rather than a database edit, and it is
 * deliberately explicit rather than sniffed from the shape of the input: a
 * mistyped TOTP code must never silently burn a recovery code.
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await verifyMfaPendingToken(bearer);
  if (!payload || payload.authRealm !== "tenant_password" || !payload.businessId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { code?: string; useRecoveryCode?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const code = body.code?.trim();
  if (!code) {
    return NextResponse.json({ error: "missing_code" }, { status: 400 });
  }

  const useRecoveryCode = body.useRecoveryCode === true;
  const enrolments = await getAccountMfaEnrolments("platform_user", payload.sub);
  const activeEnrolment =
    enrolments.find((e) => e.method === payload.method) || enrolments.find((e) => e.is_primary);

  // A recovery code is honoured against the account, not against a method —
  // the whole reason it is being used is that the enrolled method is out of
  // reach. Without an enrolment *and* without a recovery attempt there is
  // nothing to check against.
  if (!activeEnrolment && !useRecoveryCode) {
    return NextResponse.json({ error: "not_enrolled" }, { status: 400 });
  }

  const outcome = await verifyMfaCode({
    subjectRealm: "platform_user",
    subjectId: payload.sub,
    method: activeEnrolment?.method ?? null,
    code,
    useRecoveryCode,
  });

  if (outcome === "rejected") {
    // A failed OTP counts toward the Wave 1 lockout streak.
    const { recordAuthFailure } = await import("@/lib/login-lockout-service");
    const { rows } = await withoutTenantScope("platform", () =>
      query(`SELECT email FROM platform_users WHERE id = $1`, [payload.sub]),
    );
    if (rows[0]) {
      await recordAuthFailure("tenant_password", rows[0].email as string);
    }
    return NextResponse.json(
      { error: useRecoveryCode ? "invalid_recovery_code" : "invalid_code" },
      { status: 401 },
    );
  }

  const recoveryCodesRemaining =
    outcome === "recovery_code"
      ? await countRemainingRecoveryCodes("platform_user", payload.sub)
      : null;

  return withoutTenantScope("login", async () => {
    // Generate real session
    const memberships = await membershipsForPlatformUser(payload.sub);
    const chosen = memberships.find((m) => m.businessId === payload.businessId);
    if (!chosen) {
      return NextResponse.json({ error: "no_business_membership" }, { status: 403 });
    }

    const { rows } = await query<{ token_version: number }>(
      `SELECT token_version FROM platform_users WHERE id = $1`,
      [payload.sub]
    );

    const token = await signSession({
      sub: chosen.userId,
      role: chosen.role,
      businessId: chosen.businessId,
      businessSlug: chosen.businessSlug,
      businessSubdomain: chosen.businessSubdomain,
      locationId: chosen.locationId,
      fullName: chosen.fullName,
      platformUserId: payload.sub,
      tokenVersion: rows[0].token_version,
    });

    const res = NextResponse.json({
      user: { id: chosen.userId, role: chosen.role, fullName: chosen.fullName },
      business: { id: chosen.businessId, name: chosen.businessName, slug: chosen.businessSlug },
      // Surfaced so the UI can say «۶ کد بازیابی باقی مانده» right after one is
      // spent. Someone down to their last code needs to know before, not after.
      usedRecoveryCode: outcome === "recovery_code",
      recoveryCodesRemaining,
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  });
}
