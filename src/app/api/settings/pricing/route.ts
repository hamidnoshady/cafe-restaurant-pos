import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  DEFAULT_COST_DRIFT_THRESHOLD_PERCENT,
  MAX_COST_DRIFT_THRESHOLD_PERCENT,
  MAX_OVERHEAD_PERCENT,
  getEffectiveOverheadRate,
  getPricingConfig,
  setPricingConfig,
  type EffectiveOverheadRate,
  type PricingConfig,
} from "@/lib/pricing-service";

async function effectiveOverhead(
  businessId: string,
  config: PricingConfig,
): Promise<EffectiveOverheadRate | null> {
  try {
    return await getEffectiveOverheadRate(businessId, config);
  } catch {
    // The live ledger summary is explanatory status, not part of the setting
    // itself. A temporarily unavailable report must not prevent the owner from
    // reading or correcting the saved pricing policy.
    return null;
  }
}

/** Business-wide cost-plus pricing policy (menu items may override the target margin individually). */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  const pricing = await getPricingConfig(session.businessId);
  return NextResponse.json({
    pricing,
    effectiveOverhead: await effectiveOverhead(session.businessId, pricing),
  });
});

function isObjectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function parseOptionalPercent(
  value: unknown,
  max: number,
): { ok: true; value: number | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  // The JSON contract is a number, not a value JavaScript can coerce into one:
  // Number(false), Number("") and Number([]) are all zero and used to pass.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= max) {
    return { ok: false };
  }
  return { ok: true, value };
}

function parsePositivePercent(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= max) return null;
  return value;
}

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let unknownBody: unknown;
  try {
    unknownBody = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isObjectBody(unknownBody)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const body = unknownBody;

  // Treat omitted properties as unchanged. This route has accumulated newer
  // fields over time, and a partial/older client must not clear policy values
  // it did not send. Explicit null still clears the two optional estimates.
  const existing = await getPricingConfig(session.businessId);
  const defaultMarginPercent = parseOptionalPercent(
    hasOwn(body, "defaultMarginPercent") ? body.defaultMarginPercent : existing.defaultMarginPercent,
    100,
  );
  if (!defaultMarginPercent.ok) {
    return NextResponse.json({ error: "invalid_margin" }, { status: 400 });
  }
  const fallbackOverheadPercent = parseOptionalPercent(
    hasOwn(body, "fallbackOverheadPercent")
      ? body.fallbackOverheadPercent
      : existing.fallbackOverheadPercent,
    MAX_OVERHEAD_PERCENT,
  );
  if (!fallbackOverheadPercent.ok) {
    return NextResponse.json({ error: "invalid_overhead" }, { status: 400 });
  }

  const overheadMode = hasOwn(body, "overheadMode") ? body.overheadMode : existing.overheadMode ?? "automatic";
  if (overheadMode !== "automatic" && overheadMode !== "manual") {
    return NextResponse.json({ error: "invalid_overhead_mode" }, { status: 400 });
  }
  if (overheadMode === "manual" && fallbackOverheadPercent.value === null) {
    return NextResponse.json({ error: "manual_overhead_required" }, { status: 400 });
  }

  const driftCandidate = hasOwn(body, "costDriftThresholdPercent")
    ? body.costDriftThresholdPercent
    : existing.costDriftThresholdPercent ?? DEFAULT_COST_DRIFT_THRESHOLD_PERCENT;
  const costDriftThresholdPercent = parsePositivePercent(
    driftCandidate,
    MAX_COST_DRIFT_THRESHOLD_PERCENT,
  );
  // Zero would flag an unchanged recipe because 0% >= 0%; this threshold must
  // describe an actual rise.
  if (costDriftThresholdPercent === null) {
    return NextResponse.json({ error: "invalid_drift_threshold" }, { status: 400 });
  }

  const pricing: PricingConfig = {
    defaultMarginPercent: defaultMarginPercent.value,
    fallbackOverheadPercent: fallbackOverheadPercent.value,
    overheadMode,
    costDriftThresholdPercent,
  };
  await setPricingConfig(session.businessId, pricing);
  return NextResponse.json({
    ok: true,
    pricing,
    effectiveOverhead: await effectiveOverhead(session.businessId, pricing),
  });
});
