import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { getConsignorStatement, listConsignors } from "@/lib/consignment-service";

/** صورت‌حساب امانی — one consignor's full statement, or every consignor's balance when none is named. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const consignorId = request.nextUrl.searchParams.get("consignorId");
  if (consignorId) {
    const statement = await getConsignorStatement(session.businessId, consignorId);
    if (!statement) return NextResponse.json({ error: "consignor_not_found" }, { status: 404 });
    return NextResponse.json({ statement });
  }

  const consignors = await listConsignors(session.businessId);
  const statements = await Promise.all(
    consignors.map((consignor) => getConsignorStatement(session.businessId, consignor.id)),
  );
  return NextResponse.json({
    summaries: statements.filter((s) => s !== null).map((s) => ({
      consignorId: s!.consignor.id,
      name: s!.consignor.name,
      itemsOnHand: s!.itemsOnHand.length,
      totalOwed: s!.totalOwed,
      totalPaid: s!.totalPaid,
      balance: s!.balance,
    })),
  });
});
