import { NextRequest, NextResponse } from "next/server";
import { verifyMfaPendingToken } from "@/lib/mfa-service";
import { enrolMfaMethod } from "@/lib/mfa-enrol";
import { query, withoutTenantScope } from "@/lib/db";

/**
 * Enrol a platform admin's second factor, from inside the `mfa_pending`
 * interstitial. The console's counterpart to `/api/auth/mfa/enrol`; the two
 * differ only in which identity table the email comes from and which realm the
 * pending token must name.
 */
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

  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ email: string }>(
      `SELECT email::text AS email FROM platform_admins WHERE id = $1`,
      [payload.sub],
    );
    const email = rows[0]?.email;
    if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const result = await enrolMfaMethod({
      subjectRealm: "platform_admin",
      subjectId: payload.sub,
      email,
      method: body.method,
      phone: body.phone,
    });

    if (!result.ok) {
      const status = result.error === "already_enrolled" ? 409 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }

    // The super-admin realm is the one with nobody above it to perform a
    // rescue, so these ten codes — plus scripts/reset-platform-mfa.ts — are
    // the entire recovery story for the console. Shown once, here.
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
