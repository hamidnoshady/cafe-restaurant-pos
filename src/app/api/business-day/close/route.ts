import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  BusinessDayError,
  closeBusinessDay,
  reopenBusinessDay,
} from "@/lib/business-day-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * «بستن روز کاری» — ending the business day in progress early, and undoing
 * that.
 *
 * Owner/manager only, the same audience that may review someone else's shift
 * on the orders screen: this resets what every till at the branch is looking
 * at, so it is a supervisory action rather than a cashier's. It moves the live
 * window and nothing else — no sale changes hands, no report row moves — which
 * is what makes the DELETE below a genuine undo rather than a compensating
 * transaction.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerClosePeriod);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location)
    return NextResponse.json({ error: "no_location" }, { status: 409 });

  let note: string | null = null;
  try {
    const body = (await request.json()) as { note?: string };
    note = body.note?.trim() || null;
  } catch {
    // A note is optional, so a body-less POST is the normal case.
  }

  try {
    const businessDay = await closeBusinessDay(
      location.id,
      session.businessId,
      session.sub,
      note,
    );
    return NextResponse.json({ businessDay });
  } catch (err) {
    if (err instanceof BusinessDayError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});

/** Undoes a close taken by mistake, putting the window back to the day's scheduled start. */
export const DELETE = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerClosePeriod);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location)
    return NextResponse.json({ error: "no_location" }, { status: 409 });

  try {
    const businessDay = await reopenBusinessDay(
      location.id,
      session.businessId,
      session.sub,
    );
    return NextResponse.json({ businessDay });
  } catch (err) {
    if (err instanceof BusinessDayError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
