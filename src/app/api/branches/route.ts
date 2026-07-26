import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { BranchError, createBranch, listBranches } from "@/lib/branch-service";

/**
 * Branch (location) management within one business.
 *
 * Not the Phase 9 `/api/rollup/*` routes: those register *other servers* as
 * remote locations for cross-server rollup. This is the Phase 14 story —
 * several branches of one business sharing this same database, isolated from
 * each other only by application-level access checks (location-access.ts),
 * since Postgres RLS in this system draws its line at the business, not the
 * branch.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.locationsManage);
  if (error) return error;

  return NextResponse.json({ branches: await listBranches(session.businessId) });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.locationsManage);
  if (error) return error;

  let body: {
    name?: string;
    address?: string;
    phone?: string;
    timezone?: string;
    copyMenuFromLocationId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  try {
    const { locationId } = await createBranch({
      businessId: session.businessId,
      name: body.name,
      address: body.address,
      phone: body.phone,
      timezone: body.timezone,
      copyMenuFromLocationId: body.copyMenuFromLocationId ?? null,
      actorId: session.sub,
    });
    return NextResponse.json({ id: locationId }, { status: 201 });
  } catch (err) {
    if (err instanceof BranchError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
