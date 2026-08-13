import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { listReconciliations, runReconciliation } from "@/lib/integrations/reconciliation-service";

const DAY_MS = 24 * 60 * 60 * 1000;

export const GET = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;
  const reconciliations = await listReconciliations(session.businessId, id);
  return NextResponse.json({ reconciliations });
});

export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  let body: { periodStart?: string; periodEnd?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const periodEnd = body.periodEnd ?? new Date().toISOString();
  const periodStart = body.periodStart ?? new Date(new Date(periodEnd).getTime() - 30 * DAY_MS).toISOString();

  try {
    const result = await runReconciliation(session.businessId, id, session.sub, periodStart, periodEnd);
    if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ reconciliation: result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
