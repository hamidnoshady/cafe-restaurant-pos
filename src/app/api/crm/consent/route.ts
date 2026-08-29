import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { consentCoverage, listConsentEvents } from "@/lib/crm-service";

/**
 * The consent register (Phase 36) — coverage across the whole customer base,
 * plus the audit trail of every change.
 *
 * Coverage reports *granted* and *reachable* separately, because they are
 * different numbers and only the second one is a send: a customer who agreed to
 * SMS but has no phone number on file is consented and unreachable. Reporting
 * only the first is how a business plans a campaign for 400 people and messages
 * 260.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const limitParam = Number(request.nextUrl.searchParams.get("limit"));
  const [coverage, events] = await Promise.all([
    consentCoverage(session.businessId),
    listConsentEvents(session.businessId, {
      limit: Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 200,
    }),
  ]);
  return NextResponse.json({ coverage, events });
});
