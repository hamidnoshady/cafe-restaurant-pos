import { NextResponse, type NextRequest } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { DeviceError, renameDevice, revokeDevice } from "@/lib/device-service";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Revokes a paired device. Also revokes every still-active session opened
 * from it (see device-service.ts's revokeDevice) — the security-relevant
 * half of "device binding"; the terminal's registered webauthn credentials
 * are left alone (see that function's doc comment for why).
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const { id } = await context.params;
  try {
    await revokeDevice(id, session.businessId, session.sub);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof DeviceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});

/** Rename a still-active terminal without rotating its token or bindings. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { label?: unknown }).label !== "string") {
    return NextResponse.json({ error: "invalid_label" }, { status: 400 });
  }

  try {
    const device = await renameDevice(id, session.businessId, session.sub, (body as { label: string }).label);
    return NextResponse.json({ device });
  } catch (err) {
    if (err instanceof DeviceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
