import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";

/**
 * Recent journal entries (auto-posted + manual), newest first, with their
 * lines. Manual entries are no longer posted directly from this route —
 * see /api/ledger/entries/drafts for the draft -> review -> post workflow,
 * and /api/ledger/entries/[id]/reverse for reversing a posted one — but
 * every entry, however it was posted, still shows up here, including its
 * reversal linkage (reversesEntryId / reversedAt) so the UI can show both
 * sides of a reversal.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  interface EntryRow extends Record<string, unknown> {
    id: string;
    entry_date: string;
    memo: string | null;
    source_type: string | null;
    source_id: string | null;
    posted_at: string;
    created_by_name: string | null;
    reverses_entry_id: string | null;
    reversed_at: string | null;
  }
  interface LineRow extends Record<string, unknown> {
    entry_id: string;
    account_id: string;
    account_code: string;
    account_name: string;
    debit: string;
    credit: string;
  }

  const { rows: entries } = await query<EntryRow>(
    `SELECT je.id, je.entry_date, je.memo, je.source_type, je.source_id, je.posted_at,
            u.full_name AS created_by_name, je.reverses_entry_id, je.reversed_at
       FROM journal_entries je LEFT JOIN users u ON u.id = je.created_by
      WHERE je.business_id = $1
      ORDER BY je.posted_at DESC LIMIT 100`,
    [session.businessId],
  );
  if (entries.length === 0) return NextResponse.json({ entries: [] });

  const { rows: lines } = await query<LineRow>(
    `SELECT jl.entry_id, jl.account_id, a.code AS account_code, a.name AS account_name, jl.debit, jl.credit
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = ANY($1::uuid[]) ORDER BY jl.id`,
    [entries.map((e) => e.id)],
  );
  const linesByEntry = new Map<string, LineRow[]>();
  for (const l of lines) {
    const list = linesByEntry.get(l.entry_id) ?? [];
    list.push(l);
    linesByEntry.set(l.entry_id, list);
  }

  return NextResponse.json({
    entries: entries.map((e) => ({ ...e, lines: linesByEntry.get(e.id) ?? [] })),
  });
});
