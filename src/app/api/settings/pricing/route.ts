import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPricingConfig, setPricingConfig } from "@/lib/pricing-service";

/** Business-wide default target margin for cost-plus pricing suggestions (menu items may override it individually). */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  return NextResponse.json({ pricing: await getPricingConfig(session.businessId) });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: { defaultMarginPercent?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.defaultMarginPercent === null) {
    await setPricingConfig(session.businessId, { defaultMarginPercent: null });
    return NextResponse.json({ ok: true });
  }

  const defaultMarginPercent = Number(body.defaultMarginPercent);
  if (!Number.isFinite(defaultMarginPercent) || defaultMarginPercent < 0 || defaultMarginPercent >= 100) {
    return NextResponse.json({ error: "invalid_margin" }, { status: 400 });
  }

  await setPricingConfig(session.businessId, { defaultMarginPercent });
  return NextResponse.json({ ok: true });
});
