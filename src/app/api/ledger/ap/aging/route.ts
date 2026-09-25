import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getApAging } from "@/lib/ap-service";

/**
 * A date parameter the report can actually use: `YYYY-MM-DD` and a real
 * calendar date. Anything else is a client bug, and answering it with an empty
 * report (the string compare in `getApAging` filters every line out) would look
 * like «هیچ بدهی بازی وجود ندارد» — a claim, not an error.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

/** Standard 30/60/90-day AP aging as of ?asOfDate= (defaults to today). */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const asOfParam = request.nextUrl.searchParams.get("asOfDate");
  if (asOfParam !== null && asOfParam !== "" && !isValidIsoDate(asOfParam)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  return NextResponse.json(await getApAging(session.businessId, asOfParam || undefined));
});
