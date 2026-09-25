import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  createDraft,
  listDrafts,
  ManualJournalError,
} from "@/lib/manual-journal-service";

/** The review queue: every pending draft, newest first. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
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
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  let body: { entryDate?: unknown; memo?: unknown; lines?: unknown };
  try {
    const json = await request.json();
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    body = json as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.lines !== undefined && !Array.isArray(body.lines)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const rawLines = (body.lines ?? []) as unknown[];
  const lines = rawLines.map((raw) => {
    const l =
      raw && typeof raw === "object" ? (raw as Partial<DraftLineInput>) : {};
    return {
      accountId: String(l.accountId ?? ""),
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
    };
  });

  const location = await resolveActiveLocation(session);

  try {
    const draft = await createDraft({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      entryDate: body.entryDate as string | null | undefined,
      memo: body.memo as string,
      lines,
      createdBy: session.sub,
    });
    return NextResponse.json({ draft }, { status: 201 });
  } catch (err) {
    if (err instanceof ManualJournalError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
