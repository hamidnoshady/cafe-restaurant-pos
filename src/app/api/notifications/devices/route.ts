import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { notificationErrorMessage } from "@/lib/notifications";
import {
  listNotificationDevices,
  registerNotificationDevice,
  removeNotificationDeviceByEndpoint,
  type RegisterDeviceInput,
} from "@/lib/notifications-service";

/** The caller's own devices. Never anybody else's — see requireMember's contract. */
export const GET = withTenantScope(async () => {
  const guard = await requireMember();
  if (guard.error) return guard.error;
  return NextResponse.json({
    devices: await listNotificationDevices(guard.session.businessId, guard.session.sub),
  });
});

/**
 * Claims a browser push subscription for the caller.
 *
 * Called right after `pushManager.subscribe()` resolves, and again whenever the
 * browser rotates the subscription on its own — which it does without telling
 * the user — so this has to be an upsert rather than a create.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  let body: Partial<RegisterDeviceInput>;
  try {
    body = (await request.json()) as Partial<RegisterDeviceInput>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await registerNotificationDevice(
    guard.session.businessId,
    guard.session.sub,
    {
      endpoint: body.endpoint ?? "",
      p256dh: body.p256dh ?? "",
      auth: body.auth ?? "",
      platform: body.platform,
      label: body.label,
      // Taken from the request rather than from the body: a client can lie
      // about it either way, but this one is at least the browser's own claim.
      userAgent: request.headers.get("user-agent") ?? "",
    },
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: notificationErrorMessage(result.error) },
      { status: 400 },
    );
  }
  return NextResponse.json({ device: result.device }, { status: 201 });
});

/**
 * Forgets a subscription by its endpoint — what the browser has in hand when
 * `pushManager.getSubscription()` comes back with one the user has just
 * unsubscribed from, and therefore no device id to send.
 */
export const DELETE = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  const endpoint = request.nextUrl.searchParams.get("endpoint");
  if (!endpoint) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const removed = await removeNotificationDeviceByEndpoint(
    guard.session.businessId,
    guard.session.sub,
    endpoint,
  );
  return NextResponse.json({ removed });
});
