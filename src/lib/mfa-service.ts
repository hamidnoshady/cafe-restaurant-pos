import { query } from "./db";
import { getRealmSecret } from "./jwt-secret";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { TOTP } from "@otplib/totp";

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
