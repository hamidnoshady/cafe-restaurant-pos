import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { MAX_RECONCILIATION_LINE_BATCH } from "@/lib/bank-reconciliation";
import { ReconciliationError, setLineCleared, setLinesCleared } from "@/lib/reconciliation-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  /** One line — the original contract, unchanged. */
  journalLineId?: string;
  /** Or many, for «انتخاب همه»: a month of card settlements is hundreds of lines, not hundreds of requests. */
  journalLineIds?: string[];
  cleared?: boolean;
}

/** Clears or un-clears one — or a whole selection of — journal lines against this in-progress reconciliation. */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeReconciliationManage);
  if (error) return error;

  const { id } = await ctx.params;
  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    // The batch form is used only when the caller actually sent a list, so a
    // single-line PATCH keeps going through the exact path it always did.
    if (Array.isArray(body.journalLineIds)) {
      const journalLineIds = body.journalLineIds
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value !== "");
      if (journalLineIds.length === 0) {
        return NextResponse.json({ error: "journal_line_required" }, { status: 400 });
      }
      if (journalLineIds.length > MAX_RECONCILIATION_LINE_BATCH) {
        return NextResponse.json({ error: "too_many_lines" }, { status: 400 });
      }
      const { changed } = await setLinesCleared({
        businessId: session.businessId,
        reconciliationId: id,
        journalLineIds,
        cleared: Boolean(body.cleared),
      });
      return NextResponse.json({ ok: true, changed });
    }

    if (!body.journalLineId?.trim()) {
      return NextResponse.json({ error: "journal_line_required" }, { status: 400 });
    }
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
