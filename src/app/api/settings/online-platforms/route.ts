import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getOnlinePlatformsConfig, setOnlinePlatformsConfig } from "@/lib/online-platforms-service";
import { MAX_ONLINE_PLATFORM_COMMISSION_PERCENT, validCommissionPercent } from "@/lib/online-platforms";

/** SnapFood's current commission %, applied to a SnapFood-marked sale at checkout (issue #160 §4). */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  return NextResponse.json({ onlinePlatforms: await getOnlinePlatformsConfig(session.businessId) });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: { snappfoodCommissionPercent?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  let snappfood: { commissionPercent: number } | null = null;
  const rawCommission = body.snappfoodCommissionPercent;
  if (rawCommission !== null && rawCommission !== undefined) {
    // Do not use Number(value) here: Number(true), Number([]), and
    // Number("") all produce values that a malformed client could otherwise
    // save as a real contract rate. The UI sends a JSON number.
    if (!validCommissionPercent(rawCommission)) {
      return NextResponse.json(
        { error: "invalid_commission_percent", max: MAX_ONLINE_PLATFORM_COMMISSION_PERCENT },
        { status: 400 },
      );
    }
    snappfood = { commissionPercent: rawCommission };
  }

  await setOnlinePlatformsConfig(session.businessId, { snappfood });
  return NextResponse.json({ ok: true });
});
