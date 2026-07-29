import { NextRequest, NextResponse } from "next/server";
import { resolveBusinessBySyncToken } from "@/lib/server-sync";
import { buildUpdateTokenResponse } from "@/lib/app-update";

/**
 * Mints a fresh, short-lived (~1h) GHCR pull credential scoped to read-only
 * package access, via a GitHub App installation token (github-app-token.ts).
 * This is the only place that credential is ever generated; it is never
 * cached or persisted anywhere, on either side — see app-update.ts.
 *
 * Gated the same way as update-check: a real per-business sync token, no
 * legacy REMOTE_SYNC_TOKEN fallback. Only meant to be called once, right
 * before an actual pull, by scripts/check-app-update.ts.
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const businessId = await resolveBusinessBySyncToken(bearer);
  if (!businessId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result = await buildUpdateTokenResponse();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 503 });
  return NextResponse.json(result);
}
