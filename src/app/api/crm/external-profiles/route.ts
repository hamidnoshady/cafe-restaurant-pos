import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  countPendingExternalProfiles,
  listExternalProfiles,
  type ExternalProfileStatus,
} from "@/lib/crm-external-identity";

/**
 * The online-store reconciliation queue (CRM → تطبیق فروشگاه آنلاین).
 *
 * Every shopper the WooCommerce sync could not confidently identify lands
 * here. The previous behaviour was to guess — `ORDER BY created_at LIMIT 1`
 * over everyone sharing the billing phone — which meant a purchase could enter
 * the wrong person's history with nothing anywhere recording that a choice had
 * been made. This endpoint is the visible replacement for that silence.
 *
 * Owner/manager only. Deciding that an anonymous online shopper *is* a named
 * customer attaches their spending, their address and their entire purchase
 * history to a real person; that is not a shift-level call, and it is
 * deliberately not reachable by the assistant or any autopilot job either.
 */
const STATUSES: readonly string[] = [
  "pending",
  "unmapped",
  "auto_matched",
  "confirmed",
  "needs_review",
  "conflict",
  "ignored",
];

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const requested = search.get("status") ?? "pending";
  // An unknown status falls back to the review queue rather than listing
  // everything: a typo in a query string should not quietly widen the result
  // set to every shopper the store has ever sent.
  const status = (STATUSES.includes(requested) ? requested : "pending") as
    | ExternalProfileStatus
    | "pending";

  const [profiles, pending] = await Promise.all([
    listExternalProfiles(session.businessId, {
      status,
      search: search.get("q") ?? undefined,
      limit: Number(search.get("limit") ?? 100),
    }),
    countPendingExternalProfiles(session.businessId),
  ]);

  return NextResponse.json({ profiles, pending, status });
});
