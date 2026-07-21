import { NextRequest, NextResponse } from "next/server";
import { validateRollupPayload } from "@/lib/rollup";
import { ingestRollup } from "@/lib/rollup-service";

/**
 * Central-side inbox for location pushes (Phase 9). No session cookie — the
 * caller is another server, not a browser — so auth is the per-location
 * bearer token issued at registration (only its hash is stored; an invalid
 * or deactivated token gets 401 before anything touches the DB).
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const validated = validateRollupPayload(body);
  if (!validated.ok) {
    return NextResponse.json({ error: "invalid_payload", detail: validated.error }, { status: 400 });
  }

  const result = await ingestRollup(token, validated.payload);
  if (!result) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, daysApplied: result.daysApplied });
}
