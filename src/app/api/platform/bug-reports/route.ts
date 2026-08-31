import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { listBugReports } from "@/lib/platform-service";

/** The super-admin's cross-tenant inbox of reports filed by dashboard members. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("audit.read");
  if (error) return error;

  const searchParams = request.nextUrl.searchParams;
  const rawLimit = Number(searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;

  return NextResponse.json({
    reports: await listBugReports({
      status: searchParams.get("status") ?? "",
      search: searchParams.get("q") ?? "",
      limit,
    }),
  });
});
