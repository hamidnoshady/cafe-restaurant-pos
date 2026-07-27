import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getVatReport } from "@/lib/reports-service";

/**
 * Output vs input VAT and the net payable position for a period. Output VAT
 * reads vatPayable (auto-posted on every order); input VAT reads
 * vatReceivable, which a business records via its own manual journal entry
 * alongside entering a supplier bill — deliberately not wired into purchase
 * receiving itself (see getVatReport's doc comment in reports-service.ts).
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("dateFrom") ?? undefined;
  const dateTo = searchParams.get("dateTo") ?? undefined;

  const report = await getVatReport(session.businessId, { dateFrom, dateTo });
  return NextResponse.json({ report });
});
