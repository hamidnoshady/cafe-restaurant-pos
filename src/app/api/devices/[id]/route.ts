import { NextResponse, type NextRequest } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { DeviceError, revokeDevice } from "@/lib/device-service";
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
