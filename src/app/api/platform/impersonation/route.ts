import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import { listGrants } from "@/lib/platform-service";

/**
 * Recent impersonation grants, platform-wide or scoped to one business via
 * `?businessId=`. Read surface: the audit view for support access — who entered
 * which business, in what mode, for how long, and whether it is still open. Any
 * admin may see it, since accountability is the point.
 */
export async function GET(request: NextRequest) {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const businessId = request.nextUrl.searchParams.get("businessId") ?? undefined;
  return NextResponse.json({ grants: await listGrants(businessId) });
}
