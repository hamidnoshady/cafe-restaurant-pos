import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { ArError, getArAging } from "@/lib/ar-service";

/** Standard 30/60/90-day AR aging as of ?asOfDate= (defaults to the business's today). */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const asOfDate = request.nextUrl.searchParams.get("asOfDate") ?? undefined;
  try {
    return NextResponse.json(await getArAging(session.businessId, asOfDate));
  } catch (err) {
    // A malformed asOfDate must be a 400 in the API's own vocabulary, never a
    // silently wrong bucket (or Postgres's error text).
    if (err instanceof ArError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
