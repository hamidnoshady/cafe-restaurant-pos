import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { ApError, getApAging } from "@/lib/ap-service";

/** Standard 30/60/90-day AP aging as of ?asOfDate= (defaults to the business's today). */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const asOfDate = request.nextUrl.searchParams.get("asOfDate") ?? undefined;
  try {
    return NextResponse.json(await getApAging(session.businessId, asOfDate));
  } catch (err) {
    if (err instanceof ApError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
