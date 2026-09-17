import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listShifts, SHIFT_PAGE_SIZE } from "@/lib/shift-service";

/**
 * Shift history for the admin review tab (Phase 20 Wave 5) — gated the same
 * way the rest of staff administration is (`team.manage`, the permission the
 * PIN/password reset route already requires for acting on someone else's
 * credentials), since reviewing a shift is the same kind of "manage this
 * employee" action.
 *
 * Paged: the tab used to read a flat `LIMIT 200` with no way to reach anything
 * older and nothing on screen admitting it, so a branch three weeks into its
 * history simply stopped seeing its own shifts. `hasMore` is what lets the tab
 * offer «نمایش بیشتر» instead.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const limit = Number(searchParams.get("limit") ?? SHIFT_PAGE_SIZE);
  const offset = Number(searchParams.get("offset") ?? 0);

  const { shifts, hasMore } = await listShifts(session.businessId, {
    employeeId: searchParams.get("employeeId") ?? undefined,
    locationId: searchParams.get("locationId") ?? undefined,
    status: status === "open" || status === "closed" ? status : undefined,
    // A non-numeric `?limit=` is a malformed query string, not a request for
    // zero rows: fall back to the default rather than returning an empty list
    // the caller cannot tell apart from "no shifts yet".
    limit: Number.isFinite(limit) ? limit : SHIFT_PAGE_SIZE,
    offset: Number.isFinite(offset) ? offset : 0,
  });
  return NextResponse.json({ shifts, hasMore });
});
