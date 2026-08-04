import { NextRequest, NextResponse } from "next/server";
import { redeemPairingCode } from "@/lib/pairing-service";

/**
 * Trade a pairing code for a business snapshot.
 *
 * Public by necessity: the caller is a freshly-installed desktop app with no
 * session in either realm, and the code *is* the credential — the same shape
 * as /api/auth/accept-invite and the server-sync bearer routes. It lives under
 * /api/platform because the issuing side is the platform console, not because
 * it needs a platform session.
 *
 * The response carries the business's whole configuration including credential
 * hashes, so it must never be cached or logged.
 */
export async function POST(request: NextRequest) {
  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const code = body.code?.trim();
  if (!code) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const forwarded = request.headers.get("x-forwarded-for");
  const clientIp = forwarded ? forwarded.split(",")[0].trim() : request.headers.get("x-real-ip");

  const result = await redeemPairingCode(code, clientIp);
  if (!result.ok) {
    const status = {
      code_not_found: 404,
      code_expired: 410,
      code_already_redeemed: 409,
      code_revoked: 410,
    }[result.error];
    return NextResponse.json({ error: result.error }, { status });
  }

  const response = NextResponse.json({ snapshot: result.snapshot });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
