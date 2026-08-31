import { query, withoutTenantScope } from "./db";
import { getRealmSecret } from "./jwt-secret";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SmsProvider, NoopProvider } from "./sms";
import { KavenegarProvider } from "./sms-kavenegar";

export async function getSmsProvider(): Promise<SmsProvider> {
  const { rows } = await withoutTenantScope("platform", () => 
    query<{ api_key_enc: Buffer; otp_template: string }>(
      `SELECT api_key_enc, otp_template FROM platform_sms_config WHERE id = 1`
    )
  );

  let apiKey = process.env.KAVENEGAR_API_KEY;
  let template = process.env.KAVENEGAR_OTP_TEMPLATE || "verify";

  if (rows.length > 0 && rows[0].api_key_enc) {
    const key = await getSmsSecretKey();
    const data = rows[0].api_key_enc;
    // Decrypt
    // The format is IV(12) + TAG(16) + CIPHERTEXT
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      apiKey = decrypted.toString("utf8");
      if (rows[0].otp_template) {
        template = rows[0].otp_template;
      }
    } catch {
      console.error("Failed to decrypt SMS API key");
    }
  }

  if (apiKey) {
    return new KavenegarProvider(apiKey, template);
  }
  return new NoopProvider();
}

async function getSmsSecretKey(): Promise<Buffer> {
  return Buffer.from(await getRealmSecret("platform"));
}
