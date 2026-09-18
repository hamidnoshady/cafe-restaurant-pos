import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { DEVICE_TOKEN_HEADER } from "@/lib/device-token";
import { DeviceError, findActiveDeviceId, listDevices, pairDevice } from "@/lib/device-service";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Device binding — every paired terminal for this business, across branches.
 * The manager permission is the same gate used for the rest of Settings
 * hardware configuration.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  // This header is optional and never authorises the endpoint. It only lets
  // an already-authorised manager see which list row belongs to this browser.
  // Do not update last_seen_at merely because Settings was opened.
  const [devices, currentDeviceId] = await Promise.all([
    listDevices(session.businessId),
    findActiveDeviceId(request.headers.get(DEVICE_TOKEN_HEADER), session.businessId),
  ]);
  return NextResponse.json({ devices, currentDeviceId });
});

/**
 * Pairs the caller's current browser/terminal with the active branch. The
 * plaintext token is returned once and saved locally by the browser so the
 * public login flow can use it to narrow biometric credential choices.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof (body as { label?: unknown }).label !== "string"
  ) {
    return NextResponse.json({ error: "invalid_label" }, { status: 400 });
  }
  const label = (body as { label: string }).label;

  // Do not accidentally make multiple records for one browser. The UI hides
  // the form for a live local token; this check covers direct API callers and
  // keyboard/request races too. A missing or stale token remains pairable.
  const currentDeviceId = await findActiveDeviceId(
    request.headers.get(DEVICE_TOKEN_HEADER),
    session.businessId,
  );
  if (currentDeviceId) {
    return NextResponse.json({ error: "device_already_paired", currentDeviceId }, { status: 409 });
  }

  const location = await resolveActiveLocation(session);
  try {
    const { token, device } = await pairDevice(
      session.businessId,
      location?.id ?? null,
      session.sub,
      label,
    );
    return NextResponse.json({ token, device }, { status: 201 });
  } catch (err) {
    if (err instanceof DeviceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
