import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  platformAudit,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  platformAppAvailability,
  setPlatformAppAvailability,
} from "@/lib/app-availability-service";
import { appForKey } from "@/lib/apps";
import { isAppAvailabilityState, parseAppKey } from "@/lib/app-availability";

/**
 * The platform-wide state of every app — «فعال», «به‌زودی», «در حال تعمیر»,
 * «نسخهٔ آزمایشی», «غیرفعال» (migration 0128).
 *
 * The catalogue counterpart of `/api/platform/feature-flags`, one axis over: a
 * flag says whether a business is entitled to a capability, this says whether
 * the app itself is released and working. Every admin may read it; only
 * `features.write` may change it, the same capability that owns the flags.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const apps = await platformAppAvailability();
  return NextResponse.json({
    apps: apps.map((app) => ({ ...app, label: appForKey(app.app).label })),
  });
});

/** An ISO/Gregorian `YYYY-MM-DD` (what `JalaliDatePicker` emits), or nothing. */
function parseDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return value;
}

/**
 * Set an app's platform-wide state (`features.write`).
 *
 * Audited with the app, the state and the note, so "why was حسابداری down last
 * Thursday?" has an answer naming the operator who did it — the same treatment
 * `feature.override` gets.
 */
export const PATCH = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("features.write");
  if (error) return error;

  let body: { app?: unknown; state?: unknown; note?: unknown; availableFrom?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const app = parseAppKey(body.app);
  if (!app) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!isAppAvailabilityState(body.state)) {
    return NextResponse.json({ error: "invalid_app_state" }, { status: 400 });
  }
  const availableFrom = parseDate(body.availableFrom);
  if (availableFrom === undefined && body.availableFrom !== undefined) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;

  await setPlatformAppAvailability(
    app,
    { state: body.state, note, availableFrom: availableFrom ?? null },
    session.padmin,
  );
  await platformAudit({
    adminId: session.padmin,
    action: "app.availability",
    entity: "app",
    entityId: app,
    payload: { app, state: body.state, note, availableFrom: availableFrom ?? null },
  });

  const apps = await platformAppAvailability();
  return NextResponse.json({
    apps: apps.map((entry) => ({ ...entry, label: appForKey(entry.app).label })),
  });
});
