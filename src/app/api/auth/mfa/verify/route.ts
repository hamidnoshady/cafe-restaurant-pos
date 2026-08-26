import { NextRequest, NextResponse } from "next/server";
import { verifyMfaPendingToken, getAccountMfaEnrolments, getMfaSecretKey } from "@/lib/mfa-service";
import { query, withoutTenantScope } from "@/lib/db";
import { createHmac, createDecipheriv, timingSafeEqual } from "node:crypto";
import { getRealmSecret } from "@/lib/jwt-secret";
import { TOTP, NobleCryptoPlugin, ScureBase32Plugin } from "otplib";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { membershipsForPlatformUser } from "@/lib/memberships";

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await verifyMfaPendingToken(bearer);
  if (!payload || payload.authRealm !== "tenant_password" || !payload.businessId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const code = body.code?.trim();
  if (!code) {
    return NextResponse.json({ error: "missing_code" }, { status: 400 });
  }

  const enrolments = await getAccountMfaEnrolments("platform_user", payload.sub);
  const activeEnrolment = enrolments.find(e => e.method === payload.method) || enrolments.find(e => e.is_primary);

  if (!activeEnrolment) {
    return NextResponse.json({ error: "not_enrolled" }, { status: 400 });
  }

  const valid = await withoutTenantScope("platform", async () => {
    if (activeEnrolment.method === "totp") {
      const { rows } = await query<{ totp_secret: Buffer }>(
        `SELECT totp_secret FROM mfa_enrolments WHERE subject_realm = 'platform_user' AND subject_id = $1 AND method = 'totp'`,
        [payload.sub]
      );
      if (rows.length === 0 || !rows[0].totp_secret) return false;
      const data = rows[0].totp_secret;
      const iv = data.subarray(0, 12);
      const tag = data.subarray(12, 28);
      const ciphertext = data.subarray(28);
      
      let totpSecretPlain = "";
      try {
        const key = await getMfaSecretKey();
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        totpSecretPlain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch (err) {
        console.error("Failed to decrypt TOTP secret", err);
        return false;
      }



 

      const totp = new TOTP({
        crypto: new NobleCryptoPlugin(),
        base32: new ScureBase32Plugin(),
      });
      const res = await totp.verify(code, { secret: totpSecretPlain });
      const isValid = res.valid;
      if (isValid) {
        await query(`UPDATE mfa_enrolments SET confirmed_at = now() WHERE subject_realm = 'platform_user' AND subject_id = $1 AND method = 'totp' AND confirmed_at IS NULL`, [payload.sub]);
      }
      return isValid;
    }

    if (activeEnrolment.method === "sms_otp") {
      const secretKey = await getRealmSecret("platform");
      const hmac = createHmac("sha256", secretKey).update(code).digest("hex");

      const { rows } = await query<{ id: string; hashed_otp: string; attempts: number }>(
        `SELECT id, hashed_otp, attempts 
         FROM mfa_challenges 
         WHERE subject_realm = 'platform_user' AND subject_id = $1 AND expires_at > now() 
         ORDER BY created_at DESC LIMIT 1`,
        [payload.sub]
      );

      if (rows.length === 0) return false;
      
      const challenge = rows[0];
      if (challenge.attempts >= 5) {
        return false;
      }

      const isMatch = timingSafeEqual(Buffer.from(challenge.hashed_otp, "hex"), Buffer.from(hmac, "hex"));
      
      if (!isMatch) {
        await query(`UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = $1`, [challenge.id]);
        return false;
      }

      await query(`DELETE FROM mfa_challenges WHERE id = $1`, [challenge.id]);
      await query(`UPDATE mfa_enrolments SET confirmed_at = now() WHERE subject_realm = 'platform_user' AND subject_id = $1 AND method = 'sms_otp' AND confirmed_at IS NULL`, [payload.sub]);
      return true;
    }
    return false;
  });

  if (!valid) {
    // A failed OTP counts toward the Wave 1 lockout streak.
    const { recordAuthFailure } = await import("@/lib/login-lockout-service");
    const { rows } = await withoutTenantScope("platform", () => 
      query(`SELECT email FROM platform_users WHERE id = $1`, [payload.sub])
    );
    if (rows[0]) {
      await recordAuthFailure("tenant_password", rows[0].email as string);
    }
    return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  }

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
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  });
}
