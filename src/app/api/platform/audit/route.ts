import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import { listAudit } from "@/lib/platform-service";

/**
 * The platform audit log — every privileged cross-tenant action, newest first,
 * optionally scoped to one business via `?businessId=`. Read-only; any admin
 * sees it, because the console's whole accountability story is that these are
 * visible. `?limit=` caps the page (default 200, hard ceiling 500).
 */
export async function GET(request: NextRequest) {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const businessId = request.nextUrl.searchParams.get("businessId") ?? undefined;
  const limitParam = Number(request.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 200;

  return NextResponse.json({ entries: await listAudit(businessId, limit) });
}
