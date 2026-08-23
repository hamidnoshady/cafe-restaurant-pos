import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { requireManager } from "@/lib/setup-state";
import { AUTOPILOT_CATEGORIES, type AutopilotCategory } from "@/lib/ai-autopilot";
import { AUTOPILOT_LIMITS, getAutopilotSettings, setAutopilotCategory } from "@/lib/ai-autopilot-service";

function isCategory(value: unknown): value is AutopilotCategory {
  return typeof value === "string" && (AUTOPILOT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Phase 31 — per-category autopilot settings. The ceilings are returned with
 * the settings so the UI renders the real limit rather than a hard-coded copy
 * that could drift from the server's.
 */
export const GET = withTenantScope(async () => {
  const guard = await requireManager();
  if (guard.error) return guard.error;
  return NextResponse.json({
    settings: await getAutopilotSettings(guard.session.businessId),
    ceilings: AUTOPILOT_LIMITS.ceilings,
    defaults: AUTOPILOT_LIMITS.defaults,
    canEnableMoney: guard.session.role === "owner",
  });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const guard = await requireManager();
  if (guard.error) return guard.error;

  let body: {
    category?: unknown;
    enabled?: unknown;
    maxAmountRial?: unknown;
    maxPercent?: unknown;
    maxItemsPerRun?: unknown;
    dailyActionLimit?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!isCategory(body.category)) return NextResponse.json({ error: "invalid_category" }, { status: 400 });
  if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "invalid_enabled" }, { status: 400 });

  // Unattended money movement is the owner's call alone. A manager may still
  // tune this category's caps (which clampAutopilotSetting only ever narrows),
  // but cannot be the one who switches it on.
  if (body.category === "money" && body.enabled && guard.session.role !== "owner") {
    return NextResponse.json({ error: "owner_required" }, { status: 403 });
  }

  const num = (value: unknown): number | null | undefined =>
    value === undefined ? undefined : value === null ? null : Number(value);

  const saved = await setAutopilotCategory(
    guard.session.businessId,
    body.category,
    {
      enabled: body.enabled,
      maxAmountRial: num(body.maxAmountRial),
      maxPercent: num(body.maxPercent),
      maxItemsPerRun: body.maxItemsPerRun === undefined ? undefined : Number(body.maxItemsPerRun),
      dailyActionLimit: body.dailyActionLimit === undefined ? undefined : Number(body.dailyActionLimit),
    },
    guard.session.sub,
  );
  return NextResponse.json({ category: body.category, setting: saved });
});
