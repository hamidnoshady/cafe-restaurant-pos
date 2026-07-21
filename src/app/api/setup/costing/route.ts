import { NextRequest, NextResponse } from "next/server";
import { getSetting, markStepDone, setSetting, SETTING_KEYS } from "@/lib/settings";
import { costingLocked, requireManager, type CostingSetting } from "@/lib/setup-state";

/** Step 3 — inventory costing method (FIFO vs weighted average). */
export async function GET() {
  const { session, error } = await requireManager();
  if (error) return error;

  const costing = await getSetting<CostingSetting>(session.businessId, SETTING_KEYS.costing);
  const locked = await costingLocked(session.businessId);
  return NextResponse.json({ costing, locked });
}

/**
 * Saves the method. Once the first inventory transaction exists the choice is
 * locked — changing it then requires a formal revaluation process (later phase),
 * not this endpoint.
 */
export async function POST(request: NextRequest) {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: { method?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.method !== "fifo" && body.method !== "weighted_average") {
    return NextResponse.json({ error: "invalid_method" }, { status: 400 });
  }

  if (await costingLocked(session.businessId)) {
    return NextResponse.json({ error: "costing_locked" }, { status: 409 });
  }

  const setting: CostingSetting = { method: body.method, lockedAt: null };
  await setSetting(session.businessId, SETTING_KEYS.costing, setting);
  const progress = await markStepDone(session.businessId, "costing");
  return NextResponse.json({ ok: true, progress });
}
