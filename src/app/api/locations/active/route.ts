import { NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { accessibleLocationsFor, resolveActiveLocation } from "@/lib/setup-state";

/**
 * The caller's currently active branch, and the branches they may switch to.
 *
 * Self-guarding rather than role-gated: every member has an active branch,
 * from a PIN cashier fixed to one location to an owner roaming all of them,
 * so "what's my active branch" needs no permission beyond being signed in.
 */
export const GET = withTenantScope(async () => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [active, { locations, canSwitch, businessLocationCount }] = await Promise.all([
    resolveActiveLocation(session),
    accessibleLocationsFor(session),
  ]);

  // businessLocationCount is deliberately separate from locations.length: the
  // latter is already narrowed to what this member may reach, so it cannot
  // tell a single-branch business apart from a member pinned to one branch of
  // a larger one. The switcher shows nothing for the former and a static
  // label for the latter, so it needs both numbers.
  return NextResponse.json({ active, locations, canSwitch, businessLocationCount });
});
