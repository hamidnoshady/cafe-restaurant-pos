import { NextResponse } from "next/server";
import { getPlatformSession } from "@/lib/platform-auth";
import { CAPABILITIES_FOR } from "@/lib/platform-admin";

/**
 * Returns the caller's own platform session, or null. Self-guarding — like the
 * tenant `auth/me`, it reveals only the caller's own identity, so any platform
 * cookie (or none) is a valid request. The console bootstraps from this: no
 * session → bounce to `/platform/login`; a session → render, using the returned
 * capability list to decide which controls to show.
 */
export async function GET() {
  const session = await getPlatformSession();
  if (!session) {
    return NextResponse.json({ admin: null });
  }
  return NextResponse.json({
    admin: {
      id: session.padmin,
      fullName: session.fullName,
      email: session.email,
      role: session.role,
    },
    capabilities: CAPABILITIES_FOR(session.role),
  });
}
