import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { ReconciliationError, setLineCleared } from "@/lib/reconciliation-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Clears or un-clears one journal line against this in-progress reconciliation. */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const { id } = await ctx.params;
  let body: { journalLineId?: string; cleared?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.journalLineId?.trim()) {
    return NextResponse.json({ error: "journal_line_required" }, { status: 400 });
  }

  try {
    await setLineCleared({
      businessId: session.businessId,
      reconciliationId: id,
      journalLineId: body.journalLineId.trim(),
      cleared: Boolean(body.cleared),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
