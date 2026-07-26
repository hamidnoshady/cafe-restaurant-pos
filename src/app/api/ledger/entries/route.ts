import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

/** Recent journal entries (auto-posted + manual), newest first, with their lines. */
export async function GET() {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  interface EntryRow extends Record<string, unknown> {
    id: string;
    entry_date: string;
    memo: string | null;
    source_type: string | null;
    source_id: string | null;
    posted_at: string;
    created_by_name: string | null;
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
            u.full_name AS created_by_name
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
}

interface ManualLineInput {
  accountId?: string;
  debit?: number;
  credit?: number;
}

/**
 * Manual journal entry — "for anything not auto-generated" (Phase 7 scope),
 * e.g. recording an expense (Debit Expense account / Credit Cash or Bank)
 * or settling tax payable (Debit Tax Payable / Credit Cash or Bank). Any
 * balanced set of lines against real accounts is accepted; owner/manager
 * only, matching the rest of the back-office/financial surface.
 */
export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { entryDate?: string; memo?: string; lines?: ManualLineInput[] };
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

  if (!body.memo?.trim()) {
    return NextResponse.json({ error: "memo_required" }, { status: 400 });
  }

  const nonZero = lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  if (nonZero.length === 0) {
    return NextResponse.json({ error: "no_lines" }, { status: 400 });
  }
  for (const l of nonZero) {
    if (
      !l.accountId ||
      !Number.isSafeInteger(l.debit) ||
      l.debit < 0 ||
      !Number.isSafeInteger(l.credit) ||
      l.credit < 0 ||
      (l.debit !== 0 && l.credit !== 0)
    ) {
      return NextResponse.json({ error: "invalid_line" }, { status: 400 });
    }
  }
  const totalDebit = nonZero.reduce((a, l) => a + l.debit, 0);
  const totalCredit = nonZero.reduce((a, l) => a + l.credit, 0);
  if (totalDebit !== totalCredit) {
    return NextResponse.json({ error: "not_balanced", totalDebit, totalCredit }, { status: 400 });
  }

  const accountIds = nonZero.map((l) => l.accountId);
  const { rows: owned } = await query(
    "SELECT id FROM accounts WHERE business_id = $1 AND id = ANY($2::uuid[])",
    [session.businessId, accountIds],
  );
  if (owned.length !== new Set(accountIds).size) {
    return NextResponse.json({ error: "unknown_account" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  const entryDate = body.entryDate?.trim() || null;

  const client = await getPool().connect();
  let entryId: string;
  try {
    await client.query("BEGIN");
    const { rows: entry } = await client.query(
      `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, created_by)
       VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, 'manual', $5) RETURNING id`,
      [session.businessId, location?.id ?? null, entryDate, body.memo!.trim(), session.sub],
    );
    entryId = entry[0].id;
    for (const l of nonZero) {
      await client.query(
        "INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)",
        [entryId, l.accountId, l.debit, l.credit],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return NextResponse.json({ ok: true, entryId, totalDebit, totalCredit });
}
