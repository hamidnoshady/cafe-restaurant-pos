import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getArAging } from "@/lib/ar-service";

/** Standard 30/60/90-day AR aging as of ?asOfDate= (defaults to today). */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const asOfDate = request.nextUrl.searchParams.get("asOfDate") ?? undefined;
  return NextResponse.json(await getArAging(session.businessId, asOfDate));
});
