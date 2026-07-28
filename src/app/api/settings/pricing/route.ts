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

function parsePercent(value: unknown, max: number): { ok: true; value: number | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n >= max) return { ok: false };
  return { ok: true, value: n };
}

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: { defaultMarginPercent?: unknown; fallbackOverheadPercent?: unknown };
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

  await setPricingConfig(session.businessId, {
    defaultMarginPercent: defaultMarginPercent.value,
    fallbackOverheadPercent: fallbackOverheadPercent.value,
  });
  return NextResponse.json({ ok: true });
});
