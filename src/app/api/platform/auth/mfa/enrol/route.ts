import { NextRequest, NextResponse } from "next/server";
import { verifyMfaPendingToken, provisionMfaEnrolment, getAccountMfaEnrolments } from "@/lib/mfa-service";
import { withoutTenantScope } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { generateSecret, generateURI } from "otplib";

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await verifyMfaPendingToken(bearer);
  if (!payload || payload.authRealm !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { method?: string; phone?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const method = body.method;
  if (method !== "totp" && method !== "sms_otp") {
    return NextResponse.json({ error: "invalid_method" }, { status: 400 });
  }

  const enrolments = await getAccountMfaEnrolments("platform_admin", payload.sub);
  const existing = enrolments.find(e => e.method === method);
  if (existing) {
    return NextResponse.json({ error: "already_enrolled" }, { status: 409 });
  }

  return withoutTenantScope("platform", async () => {
    if (method === "totp") {
      const { query } = await import("@/lib/db");
      const { rows } = await query<{ email: string }>(`SELECT email FROM platform_admins WHERE id = $1`, [payload.sub]);
      const email = rows[0]?.email || "admin@example.com";

      const totpSecret = generateSecret();
      const totpUrl = generateURI({
        label: email,
        issuer: "CafePOS",
        secret: totpSecret,
        strategy: "totp"
      });

      const isPrimary = enrolments.length === 0;
      await provisionMfaEnrolment({ query }, "platform_admin", payload.sub, "totp", isPrimary, null, Buffer.from(totpSecret));

      return NextResponse.json({
        status: "provisioned",
        totpSecret,
        totpUrl
      });
    }

    if (method === "sms_otp") {
      const phone = normalizePhone(body.phone || "");
      if (!phone) {
        return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
      }
      
      const { query } = await import("@/lib/db");
      const isPrimary = enrolments.length === 0;
      await provisionMfaEnrolment({ query }, "platform_admin", payload.sub, "sms_otp", isPrimary, phone, null);

      return NextResponse.json({ status: "provisioned", phone });
    }

    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  });
}
