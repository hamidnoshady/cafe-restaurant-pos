import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { markStepDone } from "@/lib/settings";
import { requireManager, resolveActiveLocation } from "@/lib/setup-state";
import { query } from "@/lib/db";

/**
 * Step 7 — hardware pairing. The printers themselves are paired through the
 * same routes the Settings → Printers tab uses (/api/settings/printers);
 * there is no second printer configuration path. This route only reports the
 * branch's printers for the step's summary and marks the wizard step done
 * once real hardware has been saved.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ printers: [] });

  const { rows: printers } = await query(
    `SELECT id, name, kind, connection, is_active FROM printers
      WHERE location_id = $1 ORDER BY name`,
    [location.id],
  );
  return NextResponse.json({ printers });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: { done?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.done !== true) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const progress = await markStepDone(session.businessId, "hardware");
  return NextResponse.json({ ok: true, progress });
});
