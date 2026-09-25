import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, withoutTenantScope } from "@/lib/db";
import {
  PLATFORM_SESSION_COOKIE,
  platformSessionCookieOptions,
  signPlatformSession,
  type PlatformAdminRole,
} from "@/lib/platform-auth";
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PLATFORM_LOCKOUT_POLICY } from "@/lib/login-lockout";
import { 
  getAccountMfaEnrolments, 
  getMfaGracePeriod, 
  markMfaGracePeriod, 
  signMfaPendingToken 
} from "@/lib/mfa-service";
import { enrolmentRequirement, graceDaysRemaining, MFA_GRACE_DAYS_PLATFORM } from "@/lib/mfa";

interface PlatformAdminRow extends Record<string, unknown> {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  is_active: boolean;
  role: PlatformAdminRole;
  token_version: number;
}

/** A bcrypt hash of nothing in particular, used to keep timing uniform. */
const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

/**
 * Platform-admin login — the entrance to the *separate* super-admin realm.
 *
 * It authenticates against `platform_admins`, an entirely different table from
 * the tenant `platform_users`/`users`, and mints the `pos_platform_session`
 * cookie (scoped to `/platform`), never a tenant `pos_session`. There is by
 * design no code path from a tenant login into this table or back — the two
 * realms only ever share the signing secret, and the `realm` claim keeps even
 * that from crossing over.
 *
 * Runs bypassed: `platform_admins` is not tenant data (see migration 0021's
 * non-RLS list), and this is pre-session anyway, so there is no business to
 * scope to. It is a deliberate, documented use of `withoutTenantScope`.
 */
export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  if (!email || !password) {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  return withoutTenantScope("platform", async () => {
    const { rows } = await query<PlatformAdminRow>(
      `SELECT id, email::text AS email, full_name, password_hash, is_active, role::text AS role, token_version
         FROM platform_admins WHERE email = $1`,
      [email],
    );

    // Compare against a dummy hash when the admin is missing or disabled so a
    // wrong email and a wrong password cost the same time.
    const admin = rows[0];
    const usable = admin?.is_active ? admin : null;
    const ok = await bcrypt.compare(password, usable?.password_hash ?? DUMMY_HASH);

    // Gate on the lockout before the credential verdict — see the same
    // ordering in /api/auth/login. A locked admin answers 423 whatever the
    // password was, so the status code leaks nothing about it.
    const lockout = await checkAuthLockout("platform_admin", email, PLATFORM_LOCKOUT_POLICY);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    if (!usable || !ok) {
      await recordAuthFailure("platform_admin", email);
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    await recordAuthSuccess("platform_admin", email);

    await query(`UPDATE platform_admins SET last_login_at = now() WHERE id = $1`, [usable.id]);

    const enrolments = await getAccountMfaEnrolments("platform_admin", usable.id);
    let graceUntil = await getMfaGracePeriod("platform_admin", usable.id);
    const hasGraceRecord = graceUntil !== null;

    if (!hasGraceRecord && enrolments.length === 0) {
      // 7 days for platform admins
      await markMfaGracePeriod("platform_admin", usable.id, MFA_GRACE_DAYS_PLATFORM);
      graceUntil = await getMfaGracePeriod("platform_admin", usable.id);
    }

    const mfaState = {
      hasPrimary: enrolments.length > 0,
      graceUntil,
      // Whether a *pre-existing* record was found. Passing `true`
      // unconditionally (as this did) made a freshly stamped 14-day window read
      // as an expired one the moment `graceUntil` was momentarily null, which
      // is the difference between "you have a week" and "you are locked out".
      hasGraceRecord,
      role: usable.role
    };

    const req = enrolmentRequirement(mfaState);

    // Only `required` withholds the session. During grace the admin is signed
    // in and the console shows the enrolment nag — the behaviour the phase spec
    // describes, and the reason the window exists at all: a hard gate from day
    // one locks out every platform admin simultaneously, with nobody left to
    // rescue them.
    if (req === "required") {
      const mfaToken = await signMfaPendingToken({
        sub: usable.id,
        method: enrolments.length > 0 ? enrolments[0].method : null,
        authRealm: "platform_admin"
      });
      
      return NextResponse.json({
        mfaRequired: true,
        mfaState: req,
        mfaToken,
        mfaMethod: enrolments.length > 0 ? enrolments[0].method : null,
      });
    }

    const token = await signPlatformSession({
      padmin: usable.id,
      role: usable.role,
      fullName: usable.full_name,
      email: usable.email,
      tokenVersion: usable.token_version,
      mfaVerified: false,
    });

    const res = NextResponse.json({
      admin: { id: usable.id, fullName: usable.full_name, role: usable.role },
      ...(req === "grace"
        ? {
            mfaState: "grace" as const,
            graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
            graceDaysLeft: graceDaysRemaining(graceUntil),
          }
        : {}),
    });
    res.cookies.set(PLATFORM_SESSION_COOKIE, token, platformSessionCookieOptions());
    return res;
  });
}
