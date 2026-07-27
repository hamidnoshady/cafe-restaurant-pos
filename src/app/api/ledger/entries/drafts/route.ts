import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createDraft, listDrafts, ManualJournalError } from "@/lib/manual-journal-service";

/** The review queue: every pending draft, newest first. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  return NextResponse.json({ drafts: await listDrafts(session.businessId) });
});

interface DraftLineInput {
  accountId?: string;
  debit?: number;
  credit?: number;
}

/**
 * Drafts a manual journal entry — same access as today's posting surface,
 * but this no longer takes effect on the ledger by itself. Posting it for
 * real requires review: see /api/ledger/entries/drafts/[id]/approve, gated
 * on ledger.approve rather than this role list.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  let body: { entryDate?: string; memo?: string; lines?: DraftLineInput[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const lines = (body.lines ?? []).map((l) => ({
    accountId: String(l.accountId ?? ""),
    debit: Number(l.debit) || 0,
    credit: Number(l.credit) || 0,
  }));

  const location = await resolveActiveLocation(session);

  try {
    const draft = await createDraft({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      entryDate: body.entryDate,
      memo: body.memo ?? "",
      lines,
      createdBy: session.sub,
    });
    return NextResponse.json({ draft }, { status: 201 });
  } catch (err) {
    if (err instanceof ManualJournalError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
