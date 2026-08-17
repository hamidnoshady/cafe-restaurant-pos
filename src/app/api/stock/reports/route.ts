import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { deadStockReport, lowStockReport } from "@/lib/retail-stock-service";

/** Low-stock and dead-stock lists for this branch. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ low: [], dead: [] });

  const days = Math.max(0, Number(request.nextUrl.searchParams.get("days") ?? 90) || 90);
  const today = new Date().toISOString().slice(0, 10);

  const [low, dead] = await Promise.all([
    lowStockReport(location.id),
    deadStockReport(location.id, days, today),
  ]);
  return NextResponse.json({ low, dead });
});
