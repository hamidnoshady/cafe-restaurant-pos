import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { listRollupLocations, registerRollupLocation } from "@/lib/rollup-service";

/** Central side: registered remote locations, with last-sync/staleness. Owner only (Phase 9 decision). */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  const locations = await listRollupLocations(session.businessId);
  return NextResponse.json({ locations });
});

/**
 * Registers a remote location and returns its bearer token — the one and only
 * time the plaintext token exists; the Owner pastes it into that location's
 * sync settings.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const created = await registerRollupLocation(session.businessId, name);
  return NextResponse.json({ ok: true, ...created });
});
