import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";

interface TaxSetting {
  defaultRate: number;
}

/** Tax administration after onboarding. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  const [tax, result] = await Promise.all([
    getSetting<TaxSetting>(session.businessId, SETTING_KEYS.tax),
    query(
      `SELECT mc.id, mc.name, mc.tax_rate
         FROM menu_categories mc
         JOIN locations l ON l.id = mc.location_id
        WHERE l.business_id = $1
        ORDER BY mc.sort_order, mc.name`,
      [session.businessId],
    ),
  ]);
  return NextResponse.json({ tax, categories: result.rows });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: { defaultRate?: unknown; categories?: { id?: unknown; taxRate?: unknown }[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const defaultRate = Number(body.defaultRate);
  if (!Number.isFinite(defaultRate) || defaultRate < 0 || defaultRate > 100) {
    return NextResponse.json({ error: "invalid_rate" }, { status: 400 });
  }
  const categories = Array.isArray(body.categories) ? body.categories : [];
  for (const category of categories) {
    const rate = Number(category.taxRate);
    if (typeof category.id !== "string" || !category.id || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      return NextResponse.json({ error: "invalid_category_rate" }, { status: 400 });
    }
  }

  await setSetting(session.businessId, SETTING_KEYS.tax, { defaultRate });
  for (const category of categories) {
    await query(
      `UPDATE menu_categories mc
          SET tax_rate = $1
         FROM locations l
        WHERE mc.id = $2 AND l.id = mc.location_id AND l.business_id = $3`,
      [Number(category.taxRate), category.id, session.businessId],
    );
  }
  return NextResponse.json({ ok: true });
});
