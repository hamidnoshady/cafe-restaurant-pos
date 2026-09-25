import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { validateCategoryCreate } from "@/lib/menu-validation";
import { createCategory } from "@/lib/menu-service";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { resolveActiveLocation, type TaxSetting } from "@/lib/setup-state";

/** Create a menu category. Ongoing management, independent of the setup wizard. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const input = validateCategoryCreate(body);
  if (!input.ok) {
    return NextResponse.json({ error: input.error }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  // An absent tax rate means "the business's default", resolved here rather
  // than defaulted in the client, so the API's answer is the same whichever
  // screen sent the request.
  const tax = await getSetting<TaxSetting>(session.businessId, SETTING_KEYS.tax);
  const defaultTaxRate = input.value.taxRate ?? tax?.defaultRate ?? 0;

  const result = await createCategory(location.id, input.value, defaultTaxRate);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, id: result.id });
});
