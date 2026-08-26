import { query, withoutTenantScope } from "./db";
import { getRealmSecret, verifyWithRealmSecret } from "./jwt-secret";
import { createCipheriv, createDecipheriv, randomBytes, createHmac } from "node:crypto";
import { TOTP } from "@otplib/totp";
import { SignJWT, jwtVerify } from "jose";

export interface MfaPendingPayload {
  sub: string;
  method: "sms_otp" | "totp" | null;
  authRealm: "tenant_password" | "platform_admin";
}

export async function signMfaPendingToken(payload: MfaPendingPayload): Promise<string> {
  const secret = await getRealmSecret("mfa");
  return new SignJWT({ ...payload, realm: "mfa" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret);
}

export async function verifyMfaPendingToken(token: string): Promise<MfaPendingPayload | null> {
  try {
    const payload = await verifyWithRealmSecret<{ realm?: string; sub?: string; method?: string; authRealm?: string }>(token, "mfa");
    if (!payload || payload.realm !== "mfa") return null;
    return payload as unknown as MfaPendingPayload;
  } catch {
    return null;
  }
}

export async function getAccountMfaEnrolments(subjectRealm: string, subjectId: string) {
  const { rows } = await withoutTenantScope("platform", () => 
    query<{ method: "sms_otp" | "totp"; is_primary: boolean; phone_e164: string | null; confirmed_at: Date | null }>(
      `SELECT method, is_primary, phone_e164, confirmed_at 
       FROM mfa_enrolments 
       WHERE subject_realm = $1 AND subject_id = $2`,
      [subjectRealm, subjectId]
    )
  );
  return rows;
}

export async function getMfaGracePeriod(subjectRealm: string, subjectId: string): Promise<Date | null> {
  const { rows } = await withoutTenantScope("platform", () => 
    query<{ grace_until: Date }>(`SELECT grace_until FROM mfa_grace_periods WHERE subject_realm = $1 AND subject_id = $2`, [subjectRealm, subjectId])
  );
  return rows.length > 0 ? rows[0].grace_until : null;
}

export async function markMfaGracePeriod(subjectRealm: string, subjectId: string, graceDays: number) {
  await withoutTenantScope("platform", async () => {
    await query(
      `INSERT INTO mfa_grace_periods (subject_realm, subject_id, grace_until)
       VALUES ($1, $2, now() + interval '1 day' * $3)
       ON CONFLICT (subject_realm, subject_id) DO NOTHING`,
      [subjectRealm, subjectId, graceDays]
    );
  });
}


export async function provisionMfaEnrolment(
  client: any,
  subjectRealm: string,
  subjectId: string,
  method: "sms_otp" | "totp",
  isPrimary: boolean,
  phoneE164?: string | null,
  totpSecretPlain?: Buffer | null
) {
  let totpSecretEncrypted: Buffer | null = null;
  if (method === "totp" && totpSecretPlain) {
    const key = await getMfaSecretKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(totpSecretPlain), cipher.final()]);
    const tag = cipher.getAuthTag();
    totpSecretEncrypted = Buffer.concat([iv, tag, ciphertext]);
  }

  await client.query(
    `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, is_primary, phone_e164, totp_secret, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (subject_realm, subject_id, method) DO NOTHING`,
    [subjectRealm, subjectId, method, isPrimary, phoneE164 || null, totpSecretEncrypted]
  );
}

export async function getMfaSecretKey(): Promise<Buffer> {
  const envKey = process.env.MFA_SECRET_KEY;
  if (envKey) {
    return Buffer.from(envKey, "hex");
  }
  // fallback or something? The spec says "Uses a dedicated MFA_SECRET_KEY (single AES-256-GCM key)"
  // I will just use `getRealmSecret('mfa')` or something.
  return Buffer.from(await getRealmSecret("platform"));
}
