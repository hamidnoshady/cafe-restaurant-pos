import { NextRequest, NextResponse } from "next/server";
import { verifyMfaPendingToken, getAccountMfaEnrolments } from "@/lib/mfa-service";
import { verifyMfaCode } from "@/lib/mfa-verify";
import { countRemainingRecoveryCodes } from "@/lib/mfa-recovery";
import { query, withoutTenantScope } from "@/lib/db";
import {
  signPlatformSession,
  PLATFORM_SESSION_COOKIE,
  platformSessionCookieOptions,
  type PlatformAdminRole,
} from "@/lib/platform-auth";

/**
 * Second-factor verification for the super-admin realm.
 *
 * Same two paths as the tenant route — the enrolled factor, or a single-use
 * recovery code — and here the recovery path carries the most weight in the
 * product: there is no role above a platform admin to reset them, so the only
 * ways back into a console whose phone is gone are one of these ten codes and
 * `scripts/reset-platform-mfa.ts` run on the box itself.
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await verifyMfaPendingToken(bearer);
  if (!payload || payload.authRealm !== "platform_admin") {
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
  const enrolments = await getAccountMfaEnrolments("platform_admin", payload.sub);
  const activeEnrolment =
    enrolments.find((e) => e.method === payload.method) || enrolments.find((e) => e.is_primary);

  if (!activeEnrolment && !useRecoveryCode) {
    return NextResponse.json({ error: "not_enrolled" }, { status: 400 });
  }

  const outcome = await verifyMfaCode({
    subjectRealm: "platform_admin",
    subjectId: payload.sub,
    method: activeEnrolment?.method ?? null,
    code,
    useRecoveryCode,
  });

  if (outcome === "rejected") {
    const { recordAuthFailure } = await import("@/lib/login-lockout-service");
    const { rows } = await withoutTenantScope("platform", () =>
      query(`SELECT email FROM platform_admins WHERE id = $1`, [payload.sub]),
    );
    if (rows[0]) {
      await recordAuthFailure("platform_admin", rows[0].email as string);
    }
    return NextResponse.json(
      { error: useRecoveryCode ? "invalid_recovery_code" : "invalid_code" },
      { status: 401 },
    );
  }

  const recoveryCodesRemaining =
    outcome === "recovery_code"
      ? await countRemainingRecoveryCodes("platform_admin", payload.sub)
      : null;

  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ role: PlatformAdminRole; full_name: string; email: string; token_version: number }>(
      `SELECT role::text AS role, full_name, email, token_version FROM platform_admins WHERE id = $1`,
      [payload.sub]
    );

    const usable = rows[0];
    if (!usable) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const token = await signPlatformSession({
      padmin: payload.sub,
      role: usable.role,
      fullName: usable.full_name,
      email: usable.email,
      tokenVersion: usable.token_version,
      mfaVerified: true,
    });

    const res = NextResponse.json({
      admin: { id: payload.sub, fullName: usable.full_name, role: usable.role },
      usedRecoveryCode: outcome === "recovery_code",
      recoveryCodesRemaining,
    });
    res.cookies.set(PLATFORM_SESSION_COOKIE, token, platformSessionCookieOptions());
    return res;
  });
}
