import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { applyPairingSnapshot } from "@/lib/pairing-apply";
import { validateSnapshot } from "@/lib/pairing-snapshot";
import { hasAnyUser } from "@/lib/setup-state";

/** How long to wait on the online server before calling it unreachable. */
const REDEEM_TIMEOUT_MS = 30_000;

const PASSTHROUGH_ERRORS = new Set([
  "code_not_found",
  "code_expired",
  "code_already_redeemed",
  "code_revoked",
]);

/**
 * First-run pairing: claim an existing online business on this install.
 *
 * Public for the same reason /api/setup/bootstrap is — the database is empty,
 * so there is no session to require and no tenant to scope to. It refuses the
 * moment any user exists, which is what stops it being a way to overwrite a
 * working install.
 *
 * Everything happens server-side rather than in the browser: the snapshot
 * carries credential hashes, and routing it through the browser would put them
 * in a place they have no business being.
 */
export async function POST(request: NextRequest) {
  if (await hasAnyUser()) {
    return NextResponse.json({ error: "already_initialized" }, { status: 409 });
  }

  let body: { remoteUrl?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const remoteUrl = body.remoteUrl?.trim().replace(/\/+$/, "") ?? "";
  const code = body.code?.trim() ?? "";
  if (!remoteUrl || !code) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (!/^https?:\/\/.+/.test(remoteUrl)) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  let remoteResponse: Response;
  try {
    remoteResponse = await fetch(`${remoteUrl}/api/platform/pairing/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json({ error: "remote_unreachable" }, { status: 502 });
  }

  const payload = (await remoteResponse.json().catch(() => ({}))) as {
    snapshot?: unknown;
    error?: string;
  };

  if (!remoteResponse.ok) {
    if (payload.error && PASSTHROUGH_ERRORS.has(payload.error)) {
      return NextResponse.json({ error: payload.error }, { status: remoteResponse.status });
    }
    return NextResponse.json({ error: "remote_unreachable" }, { status: 502 });
  }

  const validation = validateSnapshot(payload.snapshot);
  if (!validation.ok) {
    return NextResponse.json({ error: "snapshot_invalid" }, { status: 502 });
  }

  // Re-checked immediately before the write: the hasAnyUser() at the top is a
  // fast rejection, but the redeem round trip above takes seconds, and
  // applying into a non-empty database would violate the primary keys the
  // snapshot carries.
  if (await hasAnyUser()) {
    return NextResponse.json({ error: "already_initialized" }, { status: 409 });
  }

  const applied = await applyPairingSnapshot(validation.snapshot, remoteUrl);

  const token = await signSession({
    sub: applied.ownerUserId,
    role: "owner",
    businessId: applied.businessId,
    businessSlug: applied.businessSlug,
    locationId: null,
    fullName: applied.ownerName,
    platformUserId: applied.ownerPlatformUserId,
  });
  const response = NextResponse.json({ ok: true, slug: applied.businessSlug });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}
