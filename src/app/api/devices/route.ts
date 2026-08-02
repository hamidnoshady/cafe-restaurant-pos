import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { DeviceError, listDevices, pairDevice } from "@/lib/device-service";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Phase 20 Wave 4 — device binding. Every paired terminal for the business,
 * across every branch (an owner reviewing "which devices can sign in
 * biometrically" wants the whole picture, not just their own branch's) —
 * gated the same way the rest of /dashboard/settings is.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const devices = await listDevices(session.businessId);
  return NextResponse.json({ devices });
});

/**
 * Pairs the caller's *current* browser/terminal — bound to whichever branch
 * the caller is presently scoped to (`resolveActiveLocation`), the same way
 * a printer registered from Settings belongs to that branch. The returned
 * token is shown exactly once; the client is expected to store it locally
 * (see src/app/login/page.tsx) and never send it back to this route again.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: { label?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.label || typeof body.label !== "string") {
    return NextResponse.json({ error: "invalid_label" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  try {
    const { token, device } = await pairDevice(
      session.businessId,
      location?.id ?? null,
      session.sub,
      body.label,
    );
    return NextResponse.json({ token, device }, { status: 201 });
  } catch (err) {
    if (err instanceof DeviceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
