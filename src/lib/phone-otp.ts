/**
 * Phase 42 — the DB-touching half of phone-OTP login: the policy read, the
 * pending-token signing, the OTP challenge send/verify, and the stamps that
 * record a verified number and open the 7-day PIN window.
 *
 * Pure rules live in phone-otp-policy.ts (unit-tested there, no imports
 * here smuggle them out of reach of the tests). The OTP challenge itself
 * reuses Phase 24's `mfa_challenges` table — hashed with the same realm
 * secret, same five-attempt burn, same shape — under its own
 * `subject_realm = 'employee_phone'`, keyed on users.id. One table, two
 * callers: an Owner's second factor and a cashier's door login differ in
 * ceremony, not in what a live challenge row means.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { SignJWT } from "jose";
import { query, withoutTenantScope } from "./db";
import { getRealmSecret, verifyWithRealmSecret } from "./jwt-secret";
import { getSmsProvider } from "./sms-config";
import { isMobilePhone, phoneE164 } from "./phone";
import {
  DEFAULT_PHONE_OTP_POLICY,
  normalizePhoneOtpPolicy,
  phoneOtpDaysRemaining,
  phoneOtpEnforcement,
  type PhoneOtpEnforcement,
  type PhoneOtpPolicy,
} from "./phone-otp-policy";
import { SETTING_KEYS } from "./settings";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export const PHONE_OTP_SETTING_KEY = SETTING_KEYS.phoneOtpPolicy;

/**
 * One business's phone-OTP policy.
 *
 * Runs with an explicit `business_id` predicate rather than relying on RLS
 * because the login paths reach it inside `withTenant(...)` at best and, on
 * the direct phone-login path, before any scope exists — the same reason and
 * the same shape as getMfaPolicy.
 */
export async function getPhoneOtpPolicy(businessId: string): Promise<PhoneOtpPolicy> {
  const { rows } = await query<{ value: unknown }>(
    `SELECT value FROM settings
      WHERE business_id = $1 AND location_id IS NULL AND key = $2`,
    [businessId, PHONE_OTP_SETTING_KEY],
  );
  return rows[0] ? normalizePhoneOtpPolicy(rows[0].value) : { ...DEFAULT_PHONE_OTP_POLICY };
}

/** The effective enforcement state for one business, SMS configuration included. */
export async function phoneOtpEnforcementFor(
  businessId: string,
): Promise<{ state: PhoneOtpEnforcement; policy: PhoneOtpPolicy; daysLeft: number | null }> {
  const [policy, sms] = await Promise.all([
    getPhoneOtpPolicy(businessId),
    // Configured-ness only — never the key. Read bypassed because this runs
    // on login paths where no session exists to carry a tenant scope.
    withoutTenantScope("platform", async () => {
      const { rows } = await query<{ api_key_enc: Buffer | null }>(
        `SELECT api_key_enc FROM platform_sms_config WHERE id = 1`,
      );
      return rows[0]?.api_key_enc != null || Boolean(process.env.KAVENEGAR_API_KEY);
    }),
  ]);
  return {
    state: phoneOtpEnforcement(policy, sms),
    policy,
    daysLeft: phoneOtpDaysRemaining(policy),
  };
}

// ---------------------------------------------------------------------------
// The pending token — what carries "this far has been proven" between steps
// ---------------------------------------------------------------------------

export interface PhonePendingPayload {
  /** users.id of the member logging in; null on the anti-enumeration path. */
  sub: string | null;
  businessId: string;
  /**
   * Whether the holder has proven the member's PIN. Only then may a *new*
   * number be attached — the roster/direct paths may only ever be sent to a
   * number already on file.
   */
  mayAttachPhone: boolean;
  /** The candidate number to attach (PIN-verified flow, phone not yet on file). */
  phone?: string | null;
  realm: "phone";
}

const PHONE_PENDING_TTL = "10m";

export async function signPhonePendingToken(
  payload: Omit<PhonePendingPayload, "realm">,
): Promise<string> {
  const secret = await getRealmSecret("phone");
  return new SignJWT({ ...payload, sub: undefined, uid: payload.sub, realm: "phone" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(PHONE_PENDING_TTL)
    .sign(secret);
}

export async function verifyPhonePendingToken(token: string): Promise<PhonePendingPayload | null> {
  try {
    const payload = await verifyWithRealmSecret<{
      realm?: string;
      uid?: string | null;
      businessId?: string;
      mayAttachPhone?: boolean;
      phone?: string | null;
    }>(token, "phone");
    if (!payload || payload.realm !== "phone") return null;
    return {
      sub: payload.uid ?? null,
      businessId: payload.businessId ?? "",
      mayAttachPhone: payload.mayAttachPhone === true,
      phone: payload.phone ?? null,
      realm: "phone",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Challenges — send & verify
// ---------------------------------------------------------------------------

const EMPLOYEE_PHONE_REALM = "employee_phone";
/** Wrong codes burn the challenge, same ceiling as the MFA interstitial. */
const MAX_OTP_ATTEMPTS = 5;
/** Till door: a code must survive a busy shift's worth of SMS lag, not a login form's. */
const OTP_TTL_MINUTES = 5;

async function hashOtp(otp: string): Promise<string> {
  const secretKey = await getRealmSecret("platform");
  return createHmac("sha256", secretKey).update(otp).digest("hex");
}

/** `+98912***4567` — enough to recognise your own number, not to dial it. */
export function maskPhoneE164(e164: string): string {
  return e164.length > 8 ? `+${e164.slice(1, 4)}***${e164.slice(-4)}` : "***";
}

/**
 * Mint a 6-digit challenge for one member and dispatch it through Kavenegar.
 *
 * Returns the send-side rate limits as a `{ allowed: false, retryAfterMs }`
 * object, mirroring mfa-rate-limit's shape so the UI can render the same
 * «درخواست بعدی تا …» sentence. A Kavenegar dispatch failure is thrown as a
 * KavenegarError for the caller to classify (user-actionable vs operator
 * fault); the challenge row it minted is deleted again on that path, since a
 * code that was never delivered must not sit live for five minutes.
 *
 * The successful send is *recorded* here — the limiter exists to cap spend,
 * so the count must happen on the path that spent the money, not be left to
 * each caller to remember.
 */
export async function sendEmployeePhoneOtp(options: {
  businessId: string;
  userId: string;
  phone: string;
}): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
  const identityKey = `${options.businessId}:${options.userId}`;
  const limit = await checkPhoneOtpRateLimit(identityKey);
  if (!limit.allowed) return limit;

  const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const hashed = await hashOtp(otp);
  await withoutTenantScope("platform", () =>
    query(
      `INSERT INTO mfa_challenges (subject_realm, subject_id, hashed_otp, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 minute' * $4)`,
      [EMPLOYEE_PHONE_REALM, options.userId, hashed, OTP_TTL_MINUTES],
    ),
  );

  try {
    const provider = await getSmsProvider();
    await provider.sendOtp(options.phone, otp);
  } catch (err) {
    await withoutTenantScope("platform", () =>
      query(`DELETE FROM mfa_challenges WHERE subject_realm = $1 AND subject_id = $2 AND hashed_otp = $3`, [
        EMPLOYEE_PHONE_REALM,
        options.userId,
        hashed,
      ]),
    ).catch(() => {});
    throw err;
  }

  await withoutTenantScope("platform", () =>
    query(
      `INSERT INTO auth_login_attempts (realm, identity_key, outcome)
       VALUES ('phone_otp', $1, 'success')`,
      [identityKey],
    ),
  );

  return { allowed: true };
}

/**
 * Check one submitted code against the member's newest live challenge.
 * True consumes the challenge; false burns one attempt and leaves it live
 * until the ceiling, so a wrong guess cannot be retried forever.
 */
export async function verifyEmployeePhoneOtp(options: {
  userId: string;
  code: string;
}): Promise<boolean> {
  const { rows } = await query<{ id: string; hashed_otp: string; attempts: number }>(
    `SELECT id, hashed_otp, attempts FROM mfa_challenges
      WHERE subject_realm = $1 AND subject_id = $2 AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [EMPLOYEE_PHONE_REALM, options.userId],
  );
  const challenge = rows[0];
  if (!challenge || challenge.attempts >= MAX_OTP_ATTEMPTS) return false;

  const offered = await hashOtp(options.code.trim());
  const stored = Buffer.from(challenge.hashed_otp, "hex");
  const candidate = Buffer.from(offered, "hex");
  const isMatch = stored.length === candidate.length && timingSafeEqual(stored, candidate);

  if (!isMatch) {
    await query(`UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = $1`, [challenge.id]);
    return false;
  }

  await query(`DELETE FROM mfa_challenges WHERE id = $1`, [challenge.id]);
  return true;
}

export async function checkPhoneOtpRateLimit(
  identityKey: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
  const now = new Date();
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ created_at: Date }>(
      `SELECT created_at FROM auth_login_attempts
        WHERE realm = 'phone_otp' AND identity_key = $1
        ORDER BY created_at DESC LIMIT 20`,
      [identityKey],
    ),
  );

  if (rows.length > 0) {
    const last = new Date(rows[0].created_at).getTime();
    if (now.getTime() - last < 60_000) {
      return { allowed: false, retryAfterMs: 60_000 - (now.getTime() - last) };
    }
  }
  const lastHour = rows.filter((r) => now.getTime() - new Date(r.created_at).getTime() < 3_600_000);
  if (lastHour.length >= 5) {
    const oldest = new Date(lastHour[4].created_at).getTime();
    return { allowed: false, retryAfterMs: 3_600_000 - (now.getTime() - oldest) };
  }
  const lastDay = rows.filter((r) => now.getTime() - new Date(r.created_at).getTime() < 86_400_000);
  if (lastDay.length >= 20) {
    const oldest = new Date(lastDay[19].created_at).getTime();
    return { allowed: false, retryAfterMs: 86_400_000 - (now.getTime() - oldest) };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// The stamps
// ---------------------------------------------------------------------------

/**
 * Mark a number verified and open the 7-day PIN window, in one write.
 *
 * `phone` is the candidate a PIN-verified login typed (users.phone_e164 was
 * still null); omitting it keeps the number already on file. Runs inside the
 * caller's tenant scope — the door has resolved the business by now.
 */
export async function stampPhoneVerified(options: {
  businessId: string;
  userId: string;
  phone?: string | null;
}): Promise<void> {
  const phone = options.phone ?? null;
  await query(
    `UPDATE users
        SET phone_e164 = COALESCE($3, phone_e164),
            phone_verified_at = now(),
            otp_login_at = now(),
            updated_at = now()
      WHERE id = $1 AND business_id = $2`,
    [options.userId, options.businessId, phone],
  );
}

/** Validate + canonicalise a typed number, or null when it is not a mobile. */
export function canonicalMemberPhone(input: string | null | undefined): string | null {
  if (!input || !String(input).trim()) return null;
  if (!isMobilePhone(input)) return null;
  return phoneE164(input);
}
