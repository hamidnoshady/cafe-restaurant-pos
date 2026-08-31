import { NextRequest, NextResponse } from "next/server";
import { query, withoutTenantScope } from "@/lib/db";
import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  extendMfaGracePeriod,
  getAccountMfaEnrolments,
  getMfaGracePeriod,
  listMfaAccountStatus,
  resetAccountMfa,
} from "@/lib/mfa-service";
import { enrolMfaMethod } from "@/lib/mfa-enrol";
import { countRemainingRecoveryCodes, issueRecoveryCodes } from "@/lib/mfa-recovery";
import {
  enrolmentRequirement,
  graceDaysRemaining,
  MFA_GRACE_DAYS_PLATFORM,
  MFA_GRACE_DAYS_TENANT,
} from "@/lib/mfa";

/**
 * Phase 24 Wave 2 — the console's two-factor surface.
 *
 * Two things live here, because they are two halves of one question an
 * operator asks at once ("is this platform actually protected, and am I?"):
 *
 *   - **the readout** the spec asks for — who is enrolled, who is in grace and
 *     how long remains, across both `platform_admins` and the business Owners
 *     the requirement applies to. Gated on `system.read`, which every admin
 *     role holds: knowing that the deadline is in three days is not privileged
 *     information, and hiding it from support is how a deadline surprises
 *     everyone at once;
 *
 *   - **the signed-in admin's own enrolment**, so an admin nagged during grace
 *     has somewhere to go. Always about the caller's own identity: `padmin`
 *     comes from the session, never from the body.
 *
 * The two writes that touch *another* account — extending one account's grace,
 * and resetting a business Owner's factor — are `admins.manage` (owner-only)
 * and both audited, per the spec's "a super-admin may extend a single
 * account's grace (audited)".
 */

/** The maximum a single grace extension may buy, in days. */
const MAX_GRACE_EXTENSION_DAYS = 30;

export const GET = withPlatformScope(async () => {
  const { session, error } = await requirePlatformCapability("system.read");
  if (error) return error;

  const now = new Date();
  const [accounts, ownEnrolments, ownGrace, ownRecovery] = await Promise.all([
    listMfaAccountStatus(now),
    getAccountMfaEnrolments("platform_admin", session.padmin),
    getMfaGracePeriod("platform_admin", session.padmin),
    countRemainingRecoveryCodes("platform_admin", session.padmin),
  ]);

  return NextResponse.json({
    accounts,
    self: {
      subjectId: session.padmin,
      requirement: enrolmentRequirement(
        {
          hasPrimary: ownEnrolments.length > 0,
          graceUntil: ownGrace,
          hasGraceRecord: ownGrace !== null,
          role: session.role,
        },
        now,
      ),
      graceUntil: ownGrace ? new Date(ownGrace).toISOString() : null,
      graceDaysLeft: graceDaysRemaining(ownGrace, now),
      methods: ownEnrolments.map((e) => ({
        method: e.method,
        isPrimary: e.is_primary,
        phoneHint: e.phone_e164 ? `***${e.phone_e164.slice(-4)}` : null,
      })),
      recoveryCodesRemaining: ownRecovery,
    },
    graceDays: { tenant: MFA_GRACE_DAYS_TENANT, platform: MFA_GRACE_DAYS_PLATFORM },
  });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const guard = await requirePlatformAdmin();
  if (guard.error) return guard.error;
  const session = guard.session;

  let body: {
    action?: string;
    method?: string;
    phone?: string;
    subjectRealm?: string;
    subjectId?: string;
    days?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // ---- The caller's own enrolment. Never gated on a capability: an admin is
  // always allowed to protect their own account better.
  if (body.action === "enrol" || body.action === "regenerate_recovery_codes") {
    return withoutTenantScope("platform", async () => {
      const { rows } = await query<{ email: string }>(
        `SELECT email::text AS email FROM platform_admins WHERE id = $1`,
        [session.padmin],
      );
      const email = rows[0]?.email;
      if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

      if (body.action === "regenerate_recovery_codes") {
        const enrolments = await getAccountMfaEnrolments("platform_admin", session.padmin);
        if (enrolments.length === 0) {
          return NextResponse.json({ error: "not_enrolled" }, { status: 400 });
        }
        return NextResponse.json({
          recoveryCodes: await issueRecoveryCodes("platform_admin", session.padmin),
        });
      }

      const result = await enrolMfaMethod({
        subjectRealm: "platform_admin",
        subjectId: session.padmin,
        email,
        method: body.method,
        phone: body.phone,
      });
      if (!result.ok) {
        const status = result.error === "already_enrolled" ? 409 : 400;
        return NextResponse.json({ error: result.error }, { status });
      }
      return NextResponse.json({
        status: "provisioned",
        method: result.method,
        totpSecret: result.totpSecret,
        totpUrl: result.totpUrl,
        totpQr: result.totpQr,
        phone: result.phone,
        recoveryCodes: result.recoveryCodes,
      });
    });
  }

  // ---- Everything below touches somebody else's account.
  const capability = await requirePlatformCapability("admins.manage");
  if (capability.error) return capability.error;

  const subjectRealm = body.subjectRealm;
  const subjectId = body.subjectId;
  if (
    (subjectRealm !== "platform_user" && subjectRealm !== "platform_admin") ||
    typeof subjectId !== "string" ||
    subjectId.length === 0
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const defaultDays =
    subjectRealm === "platform_admin" ? MFA_GRACE_DAYS_PLATFORM : MFA_GRACE_DAYS_TENANT;

  if (body.action === "extend_grace") {
    const requested = Number(body.days ?? defaultDays);
    if (!Number.isFinite(requested) || requested < 1 || requested > MAX_GRACE_EXTENSION_DAYS) {
      return NextResponse.json({ error: "invalid_days" }, { status: 400 });
    }
    const days = Math.round(requested);
    const graceUntil = await extendMfaGracePeriod(subjectRealm, subjectId, days);

    // Extending one account's grace weakens the platform's security posture for
    // that account, which is exactly the sort of act the console's whole
    // accountability story says must leave a row behind.
    await platformAudit({
      adminId: session.padmin,
      action: "mfa.grace_extended",
      entity: subjectRealm,
      entityId: subjectId,
      payload: { days, graceUntil: graceUntil?.toISOString() ?? null },
    });

    return NextResponse.json({
      graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
      graceDaysLeft: graceDaysRemaining(graceUntil),
    });
  }

  if (body.action === "reset") {
    // A super-admin may reset a *business* Owner's 2FA. Resetting another
    // platform admin's is deliberately refused: the spec puts a super-admin's
    // own reset behind a recovery code or scripts/reset-platform-mfa.ts, and
    // allowing one console account to strip another's second factor would make
    // the console a single point of compromise for the whole realm — the exact
    // thing this wave exists to prevent.
    if (subjectRealm === "platform_admin") {
      return NextResponse.json({ error: "platform_admin_reset_refused" }, { status: 403 });
    }

    await resetAccountMfa(subjectRealm, subjectId, defaultDays);
    await platformAudit({
      adminId: session.padmin,
      action: "mfa.reset",
      entity: subjectRealm,
      entityId: subjectId,
      payload: { graceDays: defaultDays },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
