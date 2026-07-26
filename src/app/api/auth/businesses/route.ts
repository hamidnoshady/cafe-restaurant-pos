import { NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { withoutTenantScope } from "@/lib/db";
import { membershipBlockedReason, membershipsForPlatformUser } from "@/lib/memberships";

/**
 * The businesses the signed-in person may switch to.
 *
 * Self-guarding (any authenticated member may ask which businesses are their
 * own), so it sits alongside /api/auth/me on the documented list of routes
 * without a `requireRole` guard.
 *
 * PIN-only staff have no platform identity and therefore exactly one business;
 * they get an empty list and the UI shows no switcher.
 */
export const GET = withTenantScope(async () => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!session.platformUserId) {
    return NextResponse.json({ businesses: [], current: session.businessId });
  }

  // Enumerating a person's other businesses is cross-tenant by definition.
  const memberships = await withoutTenantScope("login", () =>
    membershipsForPlatformUser(session.platformUserId as string),
  );

  return NextResponse.json({
    current: session.businessId,
    businesses: memberships.map((m) => ({
      id: m.businessId,
      name: m.businessName,
      slug: m.businessSlug,
      role: m.role,
      status: m.businessStatus,
      unavailableReason: membershipBlockedReason(m),
    })),
  });
});
