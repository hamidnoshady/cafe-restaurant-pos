import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { requireCoworkerFeature } from "@/lib/coworker-api-guard";
import { runAccountingReview } from "@/lib/accounting-review-service";

/**
 * Phase 32 — the accounting review over the public API, so a bookkeeper's own
 * tool can pull the same findings the dashboard shows. Read-only by
 * construction: the review never writes, whatever scope the key holds.
 */
export const GET = withApiKeyScope(async (apiKey, request: NextRequest) => {
  const denied = requireApiScope(apiKey.scopes, API_SCOPES.accountingRead);
  if (denied) return denied;
  const locked = await requireCoworkerFeature(apiKey.businessId);
  if (locked) return locked;

  const asOfDate = request.nextUrl.searchParams.get("asOfDate") ?? undefined;
  const windowParam = Number(request.nextUrl.searchParams.get("windowDays"));
  const windowDays = Number.isFinite(windowParam) && windowParam > 0 ? Math.min(365, windowParam) : undefined;

  return NextResponse.json(await runAccountingReview(apiKey.businessId, { asOfDate, windowDays }));
});
