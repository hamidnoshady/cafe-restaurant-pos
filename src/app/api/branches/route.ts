import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { BranchError, createBranch, listBranches } from "@/lib/branch-service";
import { planLimitsFor } from "@/lib/plan-limits";

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

  // The plan's ceiling travels with the list so the screen can say «۲ از ۵
  // شعبه» and disable «ایجاد شعبه» at the cap, instead of only discovering
  // the limit by submitting the form and getting a 403 back.
  const [branches, limits] = await Promise.all([
    listBranches(session.businessId),
    planLimitsFor(session.businessId),
  ]);

  return NextResponse.json({
    branches,
    plan: {
      key: limits.key,
      name: limits.name,
      branchLimit: limits.branchLimit,
      activeBranchCount: branches.filter((branch) => branch.isActive).length,
    },
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.locationsManage);
  if (error) return error;

  let body: {
    name?: string;
    address?: string;
    phone?: string;
    timezone?: string;
    color?: string;
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
      // An empty string from an untouched form field must not reach the
      // service as a zone: it is "not chosen", which is what `undefined` means
      // there (and lands on the default), not an invalid timezone.
      timezone: body.timezone?.trim() ? body.timezone : undefined,
      // Same rule as timezone: blank means "not chosen", which the service
      // answers by picking a colour no sibling branch is using.
      color: body.color?.trim() ? body.color : undefined,
      copyMenuFromLocationId: body.copyMenuFromLocationId?.trim() || null,
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
