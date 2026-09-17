import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getOnlinePlatformsConfig, setOnlinePlatformsConfig } from "@/lib/online-platforms-service";
import { listPaymentMethods } from "@/lib/payment-methods-service";
import { MAX_ONLINE_PLATFORM_COMMISSION_PERCENT, validCommissionPercent } from "@/lib/online-platforms";

/** SnapFood's current commission %, applied to a SnapFood-marked sale at checkout (issue #160 §4). */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  const [onlinePlatforms, paymentMethods] = await Promise.all([
    getOnlinePlatformsConfig(session.businessId),
    listPaymentMethods(session.businessId, { includeInactive: true }),
  ]);
  const paymentMethod = paymentMethods.find((method) => method.settlement === "snappfood") ?? null;

  return NextResponse.json({
    onlinePlatforms,
    // The rate can be saved while this built-in way is retired, but then it
    // has no effect at checkout. Return the status so the settings screen can
    // make that state visible instead of asking the owner to infer it.
    paymentMethod: paymentMethod
      ? { name: paymentMethod.name, isActive: paymentMethod.isActive }
      : null,
  });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: { snappfoodCommissionPercent?: unknown };
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    body = parsed as { snappfoodCommissionPercent?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Clearing is explicit (`null`). Treating an omitted field as "clear" makes
  // a partial/malformed request silently erase a working contract rate.
  if (!Object.prototype.hasOwnProperty.call(body, "snappfoodCommissionPercent")) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
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
