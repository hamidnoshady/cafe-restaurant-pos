import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getOnlinePlatformsConfig, setOnlinePlatformsConfig } from "@/lib/online-platforms-service";

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
  if (body.snappfoodCommissionPercent !== null && body.snappfoodCommissionPercent !== undefined) {
    const n = Number(body.snappfoodCommissionPercent);
    if (!Number.isFinite(n) || n < 0 || n >= 100) {
      return NextResponse.json({ error: "invalid_commission_percent" }, { status: 400 });
    }
    snappfood = { commissionPercent: n };
  }

  await setOnlinePlatformsConfig(session.businessId, { snappfood });
  return NextResponse.json({ ok: true });
});
