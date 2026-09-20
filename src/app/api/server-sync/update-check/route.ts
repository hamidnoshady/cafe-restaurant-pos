import { NextRequest, NextResponse } from "next/server";
import { resolveBusinessBySyncToken } from "@/lib/server-sync";
import { buildUpdateCheckResponse } from "@/lib/app-update";

/**
 * Reports this server's own currently-running version — nothing more, no
 * GitHub API call — so it's cheap enough for the local laptop's 30s sync
 * tick to poll purely for dashboard visibility (see app-update.ts).
 *
 * Requires a real site or migration-era per-business credential. Unlike
 * push/pull this has no global-token fallback. The response contains only the
 * running version: no download location, registry credential, or executable.
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const businessId = await resolveBusinessBySyncToken(bearer);
  if (!businessId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json(buildUpdateCheckResponse());
}
