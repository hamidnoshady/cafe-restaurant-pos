import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireRole, withTenantScope } from "@/lib/auth";
import { isValidStartMinutes, parseStartTime } from "@/lib/business-day";
import {
  BusinessDayError,
  getBusinessDayStatus,
  listBusinessDayClosures,
  setBusinessDayStart,
} from "@/lib/business-day-service";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * The active branch's business day (روز کاری): what it is configured to be,
 * which day is in progress, and where the live counters therefore start.
 *
 * Readable by everyone who has an operational screen keyed on it — the
 * dashboard overview and the orders list are both "today"-shaped, and a
 * cashier who cannot see which day they are ringing into is exactly the
 * confusion this feature exists to remove. Changing it is a settings
 * privilege: the start time re-buckets the branch's reporting history, so it
 * sits with `settings.manage` rather than with the till.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole(
    "owner",
    "manager",
    "cashier",
    "waiter",
  );
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location)
    return NextResponse.json({ error: "no_location" }, { status: 409 });

  const status = await getBusinessDayStatus(location.id);
  if (!status)
    return NextResponse.json({ error: "no_location" }, { status: 409 });

  // Closure history is part of the settings panel, not of the till's "which
  // day am I on?" question, so it rides along only for the audience that can
  // act on it.
  const canManage = session.role === "owner" || session.role === "manager";
  const closures = canManage ? await listBusinessDayClosures(location.id) : [];
  return NextResponse.json({
    businessDay: status,
    locationName: location.name,
    closures,
    canManage,
  });
});

interface ConfigureBody {
  /** "18:00", or null/"" to turn the business day off and go back to the calendar day. */
  startTime?: string | null;
  /** Minutes after local midnight — the same setting, for callers that already have a number. */
  startMinutes?: number | null;
}

/**
 * Turns the business day on or off for the active branch.
 *
 * Off is a real, reachable state and not an oversight: this is optional by
 * design, and a business that tries it and decides its day really does start
 * at midnight must be able to put it back exactly as it was.
 */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(
    PERMISSIONS.settingsManage,
  );
  if (error) return error;

  let body: ConfigureBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  let startMinutes: number | null;
  if (body.startTime !== undefined) {
    const text = (body.startTime ?? "").trim();
    if (text === "") {
      startMinutes = null;
    } else {
      const parsed = parseStartTime(text);
      if (parsed === null)
        return NextResponse.json(
          { error: "invalid_start_time" },
          { status: 400 },
        );
      startMinutes = parsed;
    }
  } else if (body.startMinutes === null) {
    startMinutes = null;
  } else if (isValidStartMinutes(body.startMinutes)) {
    startMinutes = body.startMinutes;
  } else {
    return NextResponse.json({ error: "invalid_start_time" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location)
    return NextResponse.json({ error: "no_location" }, { status: 409 });

  try {
    const businessDay = await setBusinessDayStart(
      location.id,
      session.businessId,
      session.sub,
      startMinutes,
    );
    return NextResponse.json({ businessDay });
  } catch (err) {
    if (err instanceof BusinessDayError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
