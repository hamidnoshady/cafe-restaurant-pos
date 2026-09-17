import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { ReconciliationError, setLinesCleared } from "@/lib/reconciliation-service";
import { MAX_RECONCILIATION_LINE_BATCH } from "@/lib/reconciliation";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  /** One line — the original contract, still honoured. */
  journalLineId?: string;
  /** Or many, for «انتخاب همه»: a month of card settlements is 300 lines, not 300 requests. */
  journalLineIds?: string[];
  cleared?: boolean;
}

/** Clears or un-clears one or more journal lines against this in-progress reconciliation. */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const { id } = await ctx.params;
  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const ids = Array.isArray(body.journalLineIds)
    ? body.journalLineIds
    : body.journalLineId
      ? [body.journalLineId]
      : [];
  const journalLineIds = ids.filter((value): value is string => typeof value === "string" && value.trim() !== "");
  if (journalLineIds.length === 0) {
    return NextResponse.json({ error: "journal_line_required" }, { status: 400 });
  }
  if (journalLineIds.length > MAX_RECONCILIATION_LINE_BATCH) {
    return NextResponse.json({ error: "too_many_lines" }, { status: 400 });
  }

  try {
    const { changed } = await setLinesCleared({
      businessId: session.businessId,
      reconciliationId: id,
      journalLineIds,
      cleared: Boolean(body.cleared),
    });
    return NextResponse.json({ ok: true, changed });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
