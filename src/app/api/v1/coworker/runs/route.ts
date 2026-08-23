import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { requireCoworkerFeature } from "@/lib/coworker-api-guard";
import { countPendingCoworkerRuns, listCoworkerRuns } from "@/lib/ai-coworker-service";
import type { CoworkerRunStatus } from "@/lib/ai-coworker";

const STATUSES = new Set([
  "pending_approval",
  "applied",
  "partially_applied",
  "rejected",
  "failed",
  "skipped",
  "reported",
]);

/** The approval inbox, for a sub app that wants to show or clear it. */
export const GET = withApiKeyScope(async (apiKey, request: NextRequest) => {
  const denied = requireApiScope(apiKey.scopes, API_SCOPES.coworkerRead);
  if (denied) return denied;
  const locked = await requireCoworkerFeature(apiKey.businessId);
  if (locked) return locked;

  const requested = request.nextUrl.searchParams.get("status");
  const status = requested && STATUSES.has(requested) ? (requested as CoworkerRunStatus) : undefined;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 30);

  const [runs, pendingCount] = await Promise.all([
    listCoworkerRuns(apiKey.businessId, { status, limit }),
    countPendingCoworkerRuns(apiKey.businessId),
  ]);
  return NextResponse.json({ runs, pendingCount });
});
