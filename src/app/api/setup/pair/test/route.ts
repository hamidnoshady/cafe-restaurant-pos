import { NextRequest, NextResponse } from "next/server";
import { normalizeServerAddress } from "@/lib/connection-code";
import { hasAnyUser } from "@/lib/setup-state";

/** Short on purpose — this answers "is that address even the right kind of thing?". */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * "Test connection" for the desktop first-run screen: does this address reach
 * a POS server at all, before the owner spends their one-time pairing code
 * finding out that it doesn't?
 *
 * A wrong address is the single most likely thing to go wrong here, and until
 * now it was indistinguishable from a wrong code: both surfaced after the code
 * had already been typed, and a code consumed against the wrong server is
 * gone. Probing `/api/setup/state` is what makes the two failures separable —
 * it is public on every install and every origin (middleware's PUBLIC_PATHS),
 * needs no credential, and answers a shape only this app answers.
 *
 * Public and session-less for the same reason `/api/setup/pair` is: the
 * database is empty. It reveals nothing — the response says only whether an
 * address speaks this protocol, which anyone able to type the address could
 * already discover — and refuses once the install has users, so it cannot
 * become a general-purpose outbound prober on a running system.
 */
export async function POST(request: NextRequest) {
  if (await hasAnyUser()) {
    return NextResponse.json({ error: "already_initialized" }, { status: 409 });
  }

  let body: { remoteUrl?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const address = normalizeServerAddress(body.remoteUrl ?? "");
  if (!address.ok) {
    return NextResponse.json(
      { error: address.error === "missing_address" ? "missing_fields" : "invalid_url" },
      { status: 400 },
    );
  }

  let response: Response;
  try {
    response = await fetch(`${address.url}/api/setup/state`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json({ error: "remote_unreachable", url: address.url }, { status: 502 });
  }

  if (!response.ok) {
    return NextResponse.json({ error: "not_a_pos_server", url: address.url }, { status: 502 });
  }

  const state = (await response.json().catch(() => null)) as { needsBootstrap?: boolean } | null;
  if (!state || typeof state.needsBootstrap !== "boolean") {
    return NextResponse.json({ error: "not_a_pos_server", url: address.url }, { status: 502 });
  }

  // A server still asking for bootstrap has no business on it yet, so it can
  // have issued no pairing code — worth saying now rather than after the code
  // is spent.
  if (state.needsBootstrap) {
    return NextResponse.json({ error: "remote_not_initialized", url: address.url }, { status: 409 });
  }

  return NextResponse.json({ ok: true, url: address.url });
}
