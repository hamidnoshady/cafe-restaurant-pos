import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, withoutTenantScope } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { hostRoutingEnabled, parseHost, requestHost, rootDomain } from "@/lib/host";
import { resolveBusinessByLabel } from "@/lib/host-resolution";
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PASSWORD_LOCKOUT_POLICY } from "@/lib/login-lockout";
import {
  membershipBlockedReason,
  membershipsForPlatformUser,
  type Membership,
} from "@/lib/memberships";
import {
  getAccountMfaEnrolments,
  getMfaGracePeriod,
  markMfaGracePeriod,
  signMfaPendingToken,
} from "@/lib/mfa-service";
import {
  enrolmentRequirement,
  graceDaysRemaining,
  mfaAppliesToRole,
  MFA_GRACE_DAYS_TENANT,
} from "@/lib/mfa";
import { getMfaPolicy } from "@/lib/mfa-policy";

interface PlatformUserRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  password_hash: string;
  is_active: boolean;
  token_version: number;
}

/** A bcrypt hash of nothing in particular, used to keep timing uniform. */
const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

function sessionFor(membership: Membership, platformUserId: string, tokenVersion: number) {
  return signSession({
    sub: membership.userId,
    role: membership.role,
    businessId: membership.businessId,
    businessSlug: membership.businessSlug,
    businessSubdomain: membership.businessSubdomain,
    locationId: membership.locationId,
    fullName: membership.fullName,
    platformUserId,
    tokenVersion,
  });
}

/**
 * Which business this origin is allowed to sign anyone into.
 *
 * `null` on an install with no root domain — a desktop or single-café install,
 * where the session simply is not host-scoped and the membership list decides.
 * Otherwise the host does: the cookie about to be minted is valid on this
 * origin and no other (see `handleHostIsolation` in src/middleware.ts), so
 * signing someone into business B on business A's host would hand them a
 * session they get bounced out of on their next click — a login loop, not a
 * login. `wrong_origin` covers the hosts that serve no tenant at all (the
 * apex, the console): there is nothing here to sign into.
 */
async function loginHostBusinessId(
  host: string | null,
): Promise<{ businessId: string | null; error: string | null }> {
  if (!hostRoutingEnabled()) return { businessId: null, error: null };

  const parsed = parseHost(host, rootDomain());
  if (parsed.kind !== "business") return { businessId: null, error: "wrong_origin" };

  const business = await resolveBusinessByLabel(parsed.label);
  // An alias is a business's *old* host after a rename. It must not mint a
  // session: the cookie about to be written would be host-scoped to this old
  // origin while the session's `businessSubdomain` names the current one, so
  // middleware would bounce the visitor straight back to a login on a host
  // that no longer serves the business. The canonical host is where login
  // happens; the alias only forwards there.
  if (!business || business.status !== "active" || business.viaAlias) {
    return { businessId: null, error: "wrong_origin" };
  }
  return { businessId: business.businessId, error: null };
}

/**
 * Email + password login.
 *
 * Since Phase 12 an email identifies a *person*, not a user of one business,
 * so this resolves the identity first and then their memberships:
 *
 *   - exactly one usable membership → signed straight in, as before;
 *   - several → 200 carrying `businesses` and no cookie; the client posts back
 *     with the chosen `businessId`;
 *   - none usable → 403 saying why (suspended business, or no membership).
 *
 * The whole handler runs bypassed: "which businesses does this email belong
 * to" is necessarily a cross-tenant question, asked before any business has
 * been chosen. It is one of the two documented holes in the isolation boundary
 * — see `withoutTenantScope` in src/lib/db.ts.
 */
export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string; businessId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { email, password } = body;
  if (!email || !password) {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  // Ahead of the credential check, and no oracle: which business a hostname
  // serves is exactly what DNS and the certificate already say out loud.
  const hostScope = await loginHostBusinessId(requestHost(request.headers));
  if (hostScope.error) {
    return NextResponse.json({ error: hostScope.error }, { status: 400 });
  }

  return withoutTenantScope("login", async () => {
    const { rows } = await query<PlatformUserRow>(
      `SELECT id, full_name, password_hash, is_active, token_version FROM platform_users WHERE email = $1`,
      [email.trim().toLowerCase()],
    );

    // Compare against a dummy hash when the identity is missing or disabled so
    // a wrong email and a wrong password cost the same time and can't be told
    // apart by an enumeration attempt.
    const identity = rows[0];
    const usableIdentity = identity?.is_active ? identity : null;
    const passwordOk = await bcrypt.compare(password, usableIdentity?.password_hash ?? DUMMY_HASH);

    // The lockout gate answers *before* the credential verdict is acted on.
    // Checking it afterwards would make it useless twice over: a wrong
    // password would return 401 without ever consulting the lockout (so it
    // throttles nothing), and a locked account would answer 423 only when the
    // password happened to be right — an oracle confirming the password.
    const lockout = await checkAuthLockout("tenant_password", email.trim().toLowerCase(), PASSWORD_LOCKOUT_POLICY);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    if (!usableIdentity || !passwordOk) {
      await recordAuthFailure("tenant_password", email.trim().toLowerCase());
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    await recordAuthSuccess("tenant_password", email.trim().toLowerCase());

    const memberships = await membershipsForPlatformUser(usableIdentity.id);
    if (memberships.length === 0) {
      return NextResponse.json({ error: "no_business_membership" }, { status: 403 });
    }

    const allUsable = memberships.filter((m) => membershipBlockedReason(m) === null);
    if (allUsable.length === 0) {
      return NextResponse.json(
        { error: "business_unavailable", reason: membershipBlockedReason(memberships[0]) },
        { status: 403 },
      );
    }

    // On a business host there is one candidate at most, so a person with
    // several memberships is never asked to pick here: they sign in on each
    // business's own address, which the apex directory hands them.
    const usable = hostScope.businessId
      ? allUsable.filter((m) => m.businessId === hostScope.businessId)
      : allUsable;
    if (usable.length === 0) {
      // Membership elsewhere, none here. Deliberately the same answer as no
      // membership at all: this origin should not confirm that the account
      // exists on some other business.
      return NextResponse.json({ error: "no_business_membership" }, { status: 403 });
    }

    const chosen = body.businessId
      ? usable.find((m) => m.businessId === body.businessId)
      : usable.length === 1
        ? usable[0]
        : undefined;

    if (!chosen) {
      return NextResponse.json({
        needsBusinessSelection: true,
        businesses: usable.map((m) => ({
          id: m.businessId,
          name: m.businessName,
          slug: m.businessSlug,
          role: m.role,
        })),
      });
    }

    await query(`UPDATE platform_users SET last_login_at = now() WHERE id = $1`, [
      usableIdentity.id,
    ]);

    // MFA Enrolment / Verification check
    //
    // Who it applies to: the `owner` role always, and `manager` only where the
    // business has opted in (settings key `mfa.policy`) — the extension the
    // phase spec describes as off by default. Cashier/waiter PIN logins never
    // reach this route at all.
    const mfaPolicy = await getMfaPolicy(chosen.businessId);
    const requiresMfa = mfaAppliesToRole(chosen.role, mfaPolicy.requireForManagers);

    // `grace` is resolved before the session is minted but does not stop it —
    // see below.
    let graceNotice: { mfaState: "grace"; graceUntil: string | null; graceDaysLeft: number | null } | null =
      null;

    if (requiresMfa) {
      const enrolments = await getAccountMfaEnrolments("platform_user", usableIdentity.id);
      let graceUntil = await getMfaGracePeriod("platform_user", usableIdentity.id);
      const hasGraceRecord = graceUntil !== null;

      if (!hasGraceRecord && enrolments.length === 0) {
        // Stamp grace at first login after deploy
        await markMfaGracePeriod("platform_user", usableIdentity.id, MFA_GRACE_DAYS_TENANT);
        graceUntil = await getMfaGracePeriod("platform_user", usableIdentity.id);
      }

      const mfaState = {
        hasPrimary: enrolments.length > 0,
        graceUntil,
        hasGraceRecord,
        role: chosen.role
      };

      const req = enrolmentRequirement(mfaState);

      // Only `required` is a gate.
      //
      // Grace exists precisely so that turning 2FA on does not lock out every
      // Owner on the platform the day it ships — an account still inside its
      // window is signed in exactly as before and shown a dismissible nag with
      // a countdown (see PasswordForm in src/app/login/login-form.tsx). Treating
      // it as a gate, as this route did until now, made the window a hard
      // lockout with a friendlier name and contradicted the phase spec, which
      // asks for "an enrolment prompt with a 'later' button and a visible
      // countdown" during the window and a hard gate only afterwards.
      if (req === "required") {
        // Issue mfa_pending token instead of full session
        const mfaToken = await signMfaPendingToken({
          sub: usableIdentity.id,
          method: enrolments.length > 0 ? enrolments[0].method : null,
          authRealm: "tenant_password",
          businessId: chosen.businessId,
        });

        return NextResponse.json({
          mfaRequired: true,
          mfaState: req,
          mfaToken,
          // Which second factor to ask for, so the client can show "enter the
          // code from your authenticator" rather than waiting for an SMS that
          // is never coming. Null means the account is not enrolled at all and
          // the screen has to enrol it first.
          mfaMethod: enrolments.length > 0 ? enrolments[0].method : null,
        });
      }

      if (req === "grace") {
        graceNotice = {
          mfaState: "grace",
          graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
          graceDaysLeft: graceDaysRemaining(graceUntil),
        };
      }
    }

    const res = NextResponse.json({
      user: { id: chosen.userId, role: chosen.role, fullName: chosen.fullName },
      business: { id: chosen.businessId, name: chosen.businessName, slug: chosen.businessSlug },
      ...(graceNotice ?? {}),
    });
    res.cookies.set(
      SESSION_COOKIE,
      await sessionFor(chosen, usableIdentity.id, usableIdentity.token_version),
      sessionCookieOptions(),
    );
    return res;
  });
}
