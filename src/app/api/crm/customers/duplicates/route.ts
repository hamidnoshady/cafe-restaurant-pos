import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { findDuplicates } from "@/lib/crm-service";

/**
 * Probable duplicate customer records (Phase 36).
 *
 * Owner/manager only, even though it only reads: this list is the entry point
 * to a merge, and a merge is irreversible. Keeping the discovery and the act
 * behind the same door means nobody arrives at the merge button by accident.
 *
 * The result is a set of *questions*, ordered by confidence. Nothing here or
 * anywhere else merges automatically at any score.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const limitParam = Number(request.nextUrl.searchParams.get("limit"));
  const duplicates = await findDuplicates(session.businessId, {
    limit: Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : undefined,
  });
  return NextResponse.json({ duplicates });
});
