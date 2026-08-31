import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  platformAudit,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  businessAppAvailability,
  setBusinessAppAvailability,
} from "@/lib/app-availability-service";
import { appForKey } from "@/lib/apps";
import { isAppAvailabilityState, parseAppKey } from "@/lib/app-availability";
import { getBusiness } from "@/lib/platform-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One business's apps: the platform-wide state, this business's override if it
 * has one, and what is actually in force. The per-tenant twin of
 * `/api/platform/app-availability`, and the exact shape
 * `/api/platform/businesses/[id]/features` has for the flags.
 */
export const GET = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const { id } = await ctx.params;
  const business = await getBusiness(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const apps = await businessAppAvailability(id);
  return NextResponse.json({
    apps: apps.map((app) => ({ ...app, label: appForKey(app.app).label })),
  });
});

function parseDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return value;
}

/**
 * Pin one app's state for this business, or clear the pin (`features.write`).
 *
 * `state: null` deletes the override so the business follows the platform row
 * again — deliberately the same contract as `setBusinessFeature(…, null)`, so
 * an operator learns one rule for both switches.
 */
export const PATCH = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("features.write");
  if (error) return error;

  const { id } = await ctx.params;
  let body: { app?: unknown; state?: unknown; note?: unknown; availableFrom?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const app = parseAppKey(body.app);
  if (!app) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const business = await getBusiness(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const clearing = body.state === null;
  if (!clearing && !isAppAvailabilityState(body.state)) {
    return NextResponse.json({ error: "invalid_app_state" }, { status: 400 });
  }
  const availableFrom = parseDate(body.availableFrom);
  if (availableFrom === undefined && body.availableFrom !== undefined) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;

  await setBusinessAppAvailability(
    id,
    app,
    clearing
      ? null
      : { state: body.state as never, note, availableFrom: availableFrom ?? null },
    session.padmin,
  );
  await platformAudit({
    adminId: session.padmin,
    businessId: id,
    action: "app.availability.override",
    entity: "app",
    entityId: app,
    payload: { app, state: clearing ? null : body.state, note, availableFrom: availableFrom ?? null },
  });

  const apps = await businessAppAvailability(id);
  return NextResponse.json({
    apps: apps.map((entry) => ({ ...entry, label: appForKey(entry.app).label })),
  });
});
