import { NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { crmOverview } from "@/lib/crm-overview";

/** This dashboard contains tenant-scoped live data; never serve a cached snapshot. */
export const dynamic = "force-dynamic";

/**
 * The CRM app's dashboard, in one call (Phase 36).
 *
 * Read-only, like the Growth overview it mirrors: every number here is derived
 * from records the other services own — orders, payments, the ledger's 2410
 * balance, the CRM's own deals and cases — so this endpoint can never disagree
 * with the books it reports on, because it never writes.
 *
 * Owner/manager only. The overview aggregates the whole customer base's spend,
 * the pipeline's expected value and consent coverage; a cashier's job needs one
 * customer at a time, which the directory and the customer file give them.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const overview = await crmOverview(session.businessId);
  return NextResponse.json(
    { overview },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
});
