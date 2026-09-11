import { NextRequest, NextResponse } from "next/server";
import { verifyMfaPendingToken } from "@/lib/mfa-service";
import { enrolMfaMethod } from "@/lib/mfa-enrol";
import { query, withoutTenantScope } from "@/lib/db";

/**
 * Enrol a business Owner's (or opted-in manager's) second factor, from inside
 * the `mfa_pending` interstitial.
 *
 * Authenticated by the pending token alone — deliberately. The person holding
 * it has just passed the password and lockout checks, and the whole reason
 * they are here is that they have no session yet. The token carries no role,
 * no `businessId` and a five-minute life (see `signMfaPendingToken`), so a
 * stolen one buys nothing but the chance to enrol a factor the thief would
 * then have to keep secret from the real Owner's next login.
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await verifyMfaPendingToken(bearer);
  if (!payload || payload.authRealm !== "tenant_password") {
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
      `SELECT email FROM platform_users WHERE id = $1`,
      [payload.sub],
    );
    const email = rows[0]?.email;
    if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    // Phase 42 — the issuer Google Authenticator shows: this business's own
    // name, so a person who is an Owner twice reads «کافه لمیز: a@b.c» and
    // «رستوران باران: a@b.c» instead of two identical «Business Suite» rows.
    const issuer = payload.businessId
      ? (
          await query<{ name: string }>(`SELECT name FROM businesses WHERE id = $1`, [
            payload.businessId,
          ])
        ).rows[0]?.name
      : undefined;

    const result = await enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: payload.sub,
      email,
      method: body.method,
      phone: body.phone,
      issuer,
    });

    if (!result.ok) {
      const status = result.error === "already_enrolled" ? 409 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }

    // `recoveryCodes` is the only time these ten strings exist outside the
    // owner's hands; nothing stores the plaintext, so a client that discards
    // this response has thrown them away for good. The UI makes the user
    // confirm they have written them down before it moves on.
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
