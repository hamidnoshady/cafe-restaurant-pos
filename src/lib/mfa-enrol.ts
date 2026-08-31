/**
 * Phase 24 Wave 2 — provisioning a second factor, shared by both realms.
 *
 * The tenant and platform enrolment routes were the same forty lines twice
 * over, which is how they both came to mint a TOTP secret and no recovery
 * codes. One implementation means the "ten codes, shown exactly once" rule the
 * spec calls mandatory cannot be present in one realm and missing in the other.
 */
import { generateSecret, generateURI } from "otplib";
import { totpQrDataUrl } from "./totp-qr";
import { query } from "./db";
import { isMobilePhone, phoneE164 } from "./phone";
import { getAccountMfaEnrolments, provisionMfaEnrolment, type MfaSubjectRealm } from "./mfa-service";
import { issueRecoveryCodes } from "./mfa-recovery";

/** The label an authenticator app shows above the six digits. */
export const TOTP_ISSUER = "CafePOS";

export type EnrolMethod = "totp" | "sms_otp";

export type EnrolResult =
  | { ok: false; error: "invalid_method" | "invalid_phone" | "already_enrolled" }
  | {
      ok: true;
      method: EnrolMethod;
      /** TOTP only. Returned once, never readable again. */
      totpSecret?: string;
      totpUrl?: string;
      /** The same URI as a scannable PNG data URL, rendered server-side. */
      totpQr?: string | null;
      /** SMS only — the canonical form actually stored. */
      phone?: string;
      /**
       * Ten single-use codes, in plaintext, for the one screen that shows them.
       * Only ever non-empty on the enrolment that establishes the account's
       * *first* factor: adding a second method to an account that already has
       * one must not silently invalidate the sheet of paper in its safe.
       */
      recoveryCodes: string[];
    };

export function totpUriFor(label: string, secret: string): string {
  return generateURI({ label, issuer: TOTP_ISSUER, secret, strategy: "totp" });
}

/**
 * Enrol one method for one identity.
 *
 * `runInScope` is the caller's bypass wrapper (`withoutTenantScope("platform", …)`):
 * `mfa_enrolments` and friends are global identity tables with no
 * `business_id`, exactly like `auth_login_attempts`, and the enrolment happens
 * before any business has been chosen.
 */
export async function enrolMfaMethod(options: {
  subjectRealm: MfaSubjectRealm;
  subjectId: string;
  /** The account's email — what the authenticator app displays. */
  email: string;
  method: string | undefined;
  phone?: string;
}): Promise<EnrolResult> {
  const { subjectRealm, subjectId, email } = options;
  const method = options.method;
  if (method !== "totp" && method !== "sms_otp") return { ok: false, error: "invalid_method" };

  const enrolments = await getAccountMfaEnrolments(subjectRealm, subjectId);
  if (enrolments.some((e) => e.method === method)) return { ok: false, error: "already_enrolled" };

  const isFirstFactor = enrolments.length === 0;

  if (method === "totp") {
    const totpSecret = generateSecret();
    const totpUrl = totpUriFor(email, totpSecret);
    await provisionMfaEnrolment(
      { query },
      subjectRealm,
      subjectId,
      "totp",
      isFirstFactor,
      null,
      Buffer.from(totpSecret),
    );
    return {
      ok: true,
      method,
      totpSecret,
      totpUrl,
      totpQr: await totpQrDataUrl(totpUrl),
      recoveryCodes: isFirstFactor ? await issueRecoveryCodes(subjectRealm, subjectId, { query }) : [],
    };
  }

  if (!isMobilePhone(options.phone)) return { ok: false, error: "invalid_phone" };
  const phone = phoneE164(options.phone);
  await provisionMfaEnrolment({ query }, subjectRealm, subjectId, "sms_otp", isFirstFactor, phone, null);
  return {
    ok: true,
    method,
    phone: phone ?? undefined,
    recoveryCodes: isFirstFactor ? await issueRecoveryCodes(subjectRealm, subjectId, { query }) : [],
  };
}
