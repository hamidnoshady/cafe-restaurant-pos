import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { wasteReport } from "@/lib/fnb-reports-service";

/** Read-only waste analytics: movement total by reason, cross-checked against the waste-expense ledger balance. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ rows: [], totalCost: 0, ledgerWasteExpense: 0 });

  const from = request.nextUrl.searchParams.get("from") ?? undefined;
  const to = request.nextUrl.searchParams.get("to") ?? undefined;
  const report = await wasteReport(session.businessId, location.id, { from, to });
  return NextResponse.json(report);
});
