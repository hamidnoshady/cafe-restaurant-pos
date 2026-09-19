import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { businessToday } from "@/lib/business-day-service";
import { growthOverview } from "@/lib/growth-overview";

/**
 * Growth & Marketing data as seen from accounting (Phase 36b, revised).
 *
 * The growth app posts to the ledger through its own posting rules — issuing a
 * gift card credits ۲۴۲۰, store credit ۲۴۱۰, commission expenses ۵۲۱۰ and
 * accrues ۲۳۰۰ — all in the backend, with no connection UI in the growth app.
 * This endpoint lets accounting *see* that same data: the bridge balances and
 * the rolling KPIs, reconstructed from `journal_lines` exactly the way the trial
 * balance reconstructs them, so a number here can never disagree with the
 * books. Owner, manager and accountant may read it.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  // The business's trading day, not the server's UTC calendar day — the same
  // reason `/api/growth/overview` uses it: the rolling window must mean the
  // same thing on this screen as it does on the app's own dashboard.
  const [location, today] = await Promise.all([
    resolveActiveLocation(session),
    businessToday(session.businessId),
  ]);
  const overview = await growthOverview(session.businessId, {
    locationId: location?.id ?? null,
    today,
  });

  return NextResponse.json({
    window: overview.window,
    bridge: overview.bridge,
    campaigns: overview.campaigns,
    giftCards: overview.giftCards,
    loyalty: overview.loyalty,
    commission: overview.commission,
  });
});
