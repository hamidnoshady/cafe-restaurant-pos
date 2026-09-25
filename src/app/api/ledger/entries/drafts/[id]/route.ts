import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deleteDraft, getDraft, ManualJournalError } from "@/lib/manual-journal-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  const draft = await getDraft(session.businessId, id);
  if (!draft) return NextResponse.json({ error: "draft_not_found" }, { status: 404 });
  return NextResponse.json({ draft });
});

/**
 * Discards a draft before it's ever posted. Either the person who drafted it
 * (changed their mind before review) or anyone holding ledger.approve (part
 * of reviewing it) may do this — everyone else needs one or the other.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  const { id } = await ctx.params;
  const draft = await getDraft(session.businessId, id);
  if (!draft) return NextResponse.json({ error: "draft_not_found" }, { status: 404 });

  if (draft.createdBy !== session.sub) {
    const approve = await requirePermission(PERMISSIONS.ledgerApprove);
    if (approve.error) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    await deleteDraft(session.businessId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ManualJournalError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
