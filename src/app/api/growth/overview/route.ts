import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { businessToday } from "@/lib/business-day-service";
import { growthOverview } from "@/lib/growth-overview";

/**
 * The Growth & Marketing app's dashboard, in one call (Phase 36b). Read-only:
 * the app's writes stay where they already are — the loyalty/promotions/
 * commission services and their posting rules — so this endpoint can never
 * disagree with the ledger it reports the balances of.
 *
 * Owner/manager only: the overview carries commission (compensation) data, the
 * same reason the ledger's payroll tab is not for managers.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  // `businessToday`, not `new Date()`: the rolling window and the campaign
  // life-cycle classifier both compare against "today", and the server's UTC
  // calendar day is not the business's trading day. A branch in Tehran whose
  // day starts at 06:00 rolled its window over at 03:30 local, so a campaign
  // ending tonight already read «پایان‌یافته» on the late shift — the same
  // off-by-one-day bug A/R aging documents.
  const [location, today] = await Promise.all([
    resolveActiveLocation(session),
    businessToday(session.businessId),
  ]);
  const overview = await growthOverview(session.businessId, {
    locationId: location?.id ?? null,
    today,
  });
  return NextResponse.json({ overview });
});
