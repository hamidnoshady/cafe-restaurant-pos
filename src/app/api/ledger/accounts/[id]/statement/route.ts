import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getAccountStatement } from "@/lib/reports-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One account's دفتر معین/گردش حساب — opening balance, every movement in
 * the given range with a running balance, closing balance. Same read access
 * as the rest of the ledger surface (Phase 16), reached from the
 * chart-of-accounts tab rather than only via a report-line drill-down.
 */
export const GET = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("dateFrom") ?? undefined;
  const dateTo = searchParams.get("dateTo") ?? undefined;

  const statement = await getAccountStatement(session.businessId, id, { dateFrom, dateTo });
  if (!statement) return NextResponse.json({ error: "account_not_found" }, { status: 404 });
  return NextResponse.json(statement);
});
