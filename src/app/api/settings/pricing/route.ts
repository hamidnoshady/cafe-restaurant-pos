import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { DEFAULT_COST_DRIFT_THRESHOLD_PERCENT, getPricingConfig, setPricingConfig } from "@/lib/pricing-service";

/** Business-wide default target margin for cost-plus pricing suggestions (menu items may override it individually). */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  return NextResponse.json({ pricing: await getPricingConfig(session.businessId) });
});

function parsePercent(value: unknown, max: number): { ok: true; value: number | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n >= max) return { ok: false };
  return { ok: true, value: n };
}

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: { defaultMarginPercent?: unknown; fallbackOverheadPercent?: unknown; overheadMode?: unknown; costDriftThresholdPercent?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Margin must stay below 100 (it divides the price), overhead has no such ceiling — just a sanity cap.
  const defaultMarginPercent = parsePercent(body.defaultMarginPercent, 100);
  if (!defaultMarginPercent.ok) return NextResponse.json({ error: "invalid_margin" }, { status: 400 });
  const fallbackOverheadPercent = parsePercent(body.fallbackOverheadPercent, 1000);
  if (!fallbackOverheadPercent.ok) return NextResponse.json({ error: "invalid_overhead" }, { status: 400 });

  // Do not reset newer settings when an older client omits them.
  const existing = await getPricingConfig(session.businessId);
  const overheadMode = body.overheadMode ?? existing.overheadMode ?? "automatic";
  if (overheadMode !== "automatic" && overheadMode !== "manual") {
    return NextResponse.json({ error: "invalid_overhead_mode" }, { status: 400 });
  }
  const drift = body.costDriftThresholdPercent ?? existing.costDriftThresholdPercent ?? DEFAULT_COST_DRIFT_THRESHOLD_PERCENT;
  const costDriftThresholdPercent = Number(drift);
  if (!Number.isFinite(costDriftThresholdPercent) || costDriftThresholdPercent < 0 || costDriftThresholdPercent >= 1000) {
    return NextResponse.json({ error: "invalid_drift_threshold" }, { status: 400 });
  }

  await setPricingConfig(session.businessId, {
    defaultMarginPercent: defaultMarginPercent.value,
    fallbackOverheadPercent: fallbackOverheadPercent.value,
    overheadMode,
    costDriftThresholdPercent,
  });
  return NextResponse.json({ ok: true });
});
