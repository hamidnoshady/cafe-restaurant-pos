import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { queryBugReports } from "@/lib/platform-service";

/** The super-admin's cross-tenant inbox of reports filed by dashboard members. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("audit.read");
  if (error) return error;

  const sp = request.nextUrl.searchParams;
  const result = await queryBugReports({
    status: sp.get("status") ?? "",
    search: sp.get("q") ?? "",
    businessId: sp.get("businessId") ?? undefined,
    page: Number(sp.get("page")) || 1,
    pageSize: Number(sp.get("pageSize")) || 40,
  });

  return NextResponse.json({
    reports: result.reports,
    statusCounts: result.statusCounts,
    meta: { total: result.total, page: result.page, pageSize: result.pageSize },
  });
});
