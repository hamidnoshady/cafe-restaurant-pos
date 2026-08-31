import { NextRequest, NextResponse } from "next/server";
import { verifyMfaPendingToken, getAccountMfaEnrolments } from "@/lib/mfa-service";
import { checkMfaChallengeRateLimit, recordMfaChallenge } from "@/lib/mfa-rate-limit";
import { getSmsProvider } from "@/lib/sms-config";
import { query, withoutTenantScope } from "@/lib/db";
import { createHmac, randomInt } from "node:crypto";
import { getRealmSecret } from "@/lib/jwt-secret";

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await verifyMfaPendingToken(bearer);
  if (!payload || payload.authRealm !== "tenant_password") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Get email from platform_users to apply rate limits
  const identity = await withoutTenantScope("platform", async () => {
    const { rows } = await query<{ email: string }>(`SELECT email FROM platform_users WHERE id = $1`, [payload.sub]);
    return rows[0];
  });
  
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rateLimit = await checkMfaChallengeRateLimit(identity.email);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterMs: rateLimit.retryAfterMs },
      { status: 429 }
    );
  }

  const enrolments = await getAccountMfaEnrolments("platform_user", payload.sub);
  const activeEnrolment = enrolments.find(e => e.method === payload.method) || enrolments.find(e => e.is_primary);

  if (!activeEnrolment) {
    return NextResponse.json({ error: "invalid_method" }, { status: 400 });
  }

  if (activeEnrolment.method === "totp") {
    // TOTP requires no challenge creation (it evaluates against the persistent secret)
    return NextResponse.json({ status: "ready" });
  }

  // SMS OTP
  if (!activeEnrolment.phone_e164) {
    return NextResponse.json({ error: "missing_phone" }, { status: 400 });
  }

  // Generate 6 digit OTP
  const otp = String(randomInt(0, 1000000)).padStart(6, "0");
  
  // Store securely
  const secretKey = await getRealmSecret("platform");
  const hmac = createHmac("sha256", secretKey).update(otp).digest("hex");
  
  await withoutTenantScope("platform", () => 
    query(
      `INSERT INTO mfa_challenges (subject_realm, subject_id, hashed_otp, expires_at)
       VALUES ('platform_user', $1, $2, now() + interval '2 minutes')`,
      [payload.sub, hmac]
    )
  );

  await recordMfaChallenge(identity.email);

  try {
    const provider = await getSmsProvider();
    await provider.sendOtp(activeEnrolment.phone_e164, otp);
  } catch (err) {
    console.error("SMS dispatch failed", err);
    return NextResponse.json({ error: "sms_dispatch_failed" }, { status: 502 });
  }

  // Redact the phone for the response
  const phone = activeEnrolment.phone_e164;
  const maskedPhone = phone.length > 4 ? `+${phone.slice(1, 4)}***${phone.slice(-4)}` : "***";

  return NextResponse.json({ status: "sent", maskedPhone });
}
