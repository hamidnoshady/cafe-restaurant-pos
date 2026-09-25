import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ManualJournalError, reverseEntry } from "@/lib/manual-journal-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Reverses a posted manual entry: a new entry with every line's debit and
 * credit swapped, dated today (or a given date) rather than backdated into
 * the original's period. Same trust level as approving a draft —
 * ledger.approve — since this is an equally ledger-altering action.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerApprove);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { memo?: string; entryDate?: string } = {};
  try {
    body = await request.json();
  } catch {
    // no body is fine; memo/entryDate are optional
  }

  const location = await resolveActiveLocation(session);

  try {
    const result = await reverseEntry({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      entryId: id,
      actorId: session.sub,
      memo: body.memo,
      entryDate: body.entryDate,
      sync: { actorRole: session.role },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ManualJournalError) return NextResponse.json({ error: err.message }, { status: err.status });
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
