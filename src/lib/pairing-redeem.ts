/**
 * The request half of pairing-code redemption, shared by the two URLs that
 * expose it.
 *
 * There are two because of where the credential is now issued. Redemption has
 * always lived under `/api/platform/pairing/redeem`, and middleware moves
 * *anything* under `/api/platform` to the console's own host — correct for the
 * console, wrong here: since an owner can issue a desktop code from their own
 * dashboard, the address they hand the desktop app is their own business
 * origin (`biz1.example.com`), and pairing against it would bounce through a
 * cross-host redirect before it ever reached a handler. `/api/pairing/redeem`
 * is the same exchange with no `/api/platform` prefix, so it answers on
 * whatever origin the owner copied.
 *
 * The old URL stays, unchanged in behaviour: every desktop build already
 * shipped points at it, and `/api/setup/pair` still falls back to it when a
 * cloud server is too old to serve the new one.
 */
import { NextRequest, NextResponse } from "next/server";
import { redeemPairingCode } from "./pairing-service";

/** The caller's address, for the `redeemed_ip` audit column. Best-effort by nature. */
function clientIp(request: NextRequest): string | null {
  const edgeIp = (request as unknown as { ip?: string }).ip;
  const realIp = request.headers.get("x-real-ip") ?? edgeIp ?? null;
  if (realIp) return realIp;

  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const parts = forwarded.split(",");
  for (let i = parts.length - 1; i >= 0; i--) {
    const ip = parts[i].trim();
    if (!isPrivateIp(ip)) return ip;
  }
  return parts[parts.length - 1].trim();
}

function isPrivateIp(ip: string): boolean {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("127.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
    ip === "::1" ||
    ip.toLowerCase().startsWith("fc00:") ||
    ip.toLowerCase().startsWith("fe80:")
  );
}

const STATUS_BY_ERROR: Record<string, number> = {
  code_not_found: 404,
  code_expired: 410,
  code_already_redeemed: 409,
  code_revoked: 410,
};

/**
 * Trade a pairing code for a business snapshot.
 *
 * Public by necessity: the caller is a freshly-installed desktop app with no
 * session in either realm, and the code *is* the credential — the same shape
 * as /api/auth/accept-invite and the server-sync bearer routes.
 *
 * The response carries the business's whole configuration including credential
 * hashes, so it must never be cached or logged.
 */
export async function handlePairingRedeem(request: NextRequest): Promise<NextResponse> {
  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const code = body.code?.trim();
  if (!code) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const result = await redeemPairingCode(code, clientIp(request));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: STATUS_BY_ERROR[result.error] ?? 400 });
  }

  const response = NextResponse.json({ snapshot: result.snapshot });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
