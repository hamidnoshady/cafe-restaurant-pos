/**
 * Phase 16 — manual journals, properly: draft -> review -> post, and
 * reversal rather than deletion.
 *
 * A draft has no financial effect until approved; approving it posts a real
 * journal entry through the same postJournalEntry() path (and the same
 * fiscal-period lock trigger) any other posting goes through. Reversing a
 * posted manual entry always posts a new, real, immediate entry too — Debit
 * and Credit swapped from the original — rather than editing or deleting
 * it, so both stay visible and the net effect is zero (the Phase 16 exit
 * criterion this satisfies).
 *
 * DB-touching, so per repo convention it has no direct unit test; the line
 * validation this reuses is the same shape src/app/api/ledger/entries/
 * route.ts already validated inline before this existed. Covered by
 * integration/manual-journal.integration.test.ts.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { postExactJournalEntry, postJournalEntry } from "./ledger-service";
import type { JournalLine } from "./ledger";
import type { RialText } from "./inventory-exact";

export class ManualJournalError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export interface DraftLineInput {
  accountId: string;
  debit: number;
  credit: number;
}

function isGregorianLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function normalizeEntryDate(
  entryDate: string | null | undefined,
): string | null {
  if (entryDate === null || entryDate === undefined) return null;
  if (typeof entryDate !== "string") {
    throw new ManualJournalError("invalid_entry_date");
  }
  const value = entryDate.trim();
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new ManualJournalError("invalid_entry_date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysByMonth = [
    31,
    isGregorianLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const daysInMonth = daysByMonth[month - 1] ?? 0;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    throw new ManualJournalError("invalid_entry_date");
  }
  return value;
}

function validatedNonZeroLines(lines: DraftLineInput[]): DraftLineInput[] {
  const nonZero = lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  if (nonZero.length === 0) throw new ManualJournalError("no_lines");
  for (const l of nonZero) {
    if (
      !l.accountId ||
      !Number.isSafeInteger(l.debit) ||
      l.debit < 0 ||
      !Number.isSafeInteger(l.credit) ||
      l.credit < 0 ||
      (l.debit !== 0 && l.credit !== 0)
    ) {
      throw new ManualJournalError("invalid_line");
    }
  }
  const totalDebit = nonZero.reduce((sum, l) => sum + BigInt(l.debit), 0n);
  const totalCredit = nonZero.reduce((sum, l) => sum + BigInt(l.credit), 0n);
  if (totalDebit !== totalCredit) throw new ManualJournalError("not_balanced");
  return nonZero;
}

async function assertAccountsOwned(
  businessId: string,
  accountIds: string[],
  client?: Pick<PoolClient, "query">,
): Promise<void> {
  const args = [businessId, accountIds];
  const { rows } = client
    ? await client.query<{ id: string }>(
        `SELECT id FROM accounts WHERE business_id = $1 AND id = ANY($2::uuid[]) AND is_active`,
        args,
      )
    : await query<{ id: string }>(
        `SELECT id FROM accounts WHERE business_id = $1 AND id = ANY($2::uuid[]) AND is_active`,
        args,
      );
  if (rows.length !== new Set(accountIds).size)
    throw new ManualJournalError("unknown_account");
}

export interface DraftLine extends DraftLineInput {
  accountCode: string;
  accountName: string;
}

export interface JournalDraft {
  id: string;
  entryDate: string | null;
  locationId: string | null;
  memo: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  lines: DraftLine[];
}

interface DraftRow extends Record<string, unknown> {
  id: string;
  entry_date: string | null;
  location_id: string | null;
  memo: string;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}
interface DraftLineRow extends Record<string, unknown> {
  draft_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  debit: string;
  credit: string;
}

async function attachLines(
  businessId: string,
  drafts: DraftRow[],
  client?: Pick<PoolClient, "query">,
): Promise<JournalDraft[]> {
  if (drafts.length === 0) return [];
  const args = [businessId, drafts.map((d) => d.id)];
  const { rows: lines } = client
    ? await client.query<DraftLineRow>(
        `SELECT dl.draft_id, dl.account_id, a.code AS account_code, a.name AS account_name, dl.debit::text AS debit, dl.credit::text AS credit
           FROM journal_entry_draft_lines dl
           JOIN accounts a ON a.id = dl.account_id
           JOIN journal_entry_drafts d ON d.id = dl.draft_id
          WHERE d.business_id = $1 AND dl.draft_id = ANY($2::uuid[])
          ORDER BY dl.id`,
        args,
      )
    : await query<DraftLineRow>(
        `SELECT dl.draft_id, dl.account_id, a.code AS account_code, a.name AS account_name, dl.debit::text AS debit, dl.credit::text AS credit
           FROM journal_entry_draft_lines dl
           JOIN accounts a ON a.id = dl.account_id
           JOIN journal_entry_drafts d ON d.id = dl.draft_id
          WHERE d.business_id = $1 AND dl.draft_id = ANY($2::uuid[])
          ORDER BY dl.id`,
        args,
      );
  const linesByDraft = new Map<string, DraftLine[]>();
  for (const l of lines) {
    const list = linesByDraft.get(l.draft_id) ?? [];
    list.push({
      accountId: l.account_id,
      accountCode: l.account_code,
      accountName: l.account_name,
      debit: Number(l.debit),
      credit: Number(l.credit),
    });
    linesByDraft.set(l.draft_id, list);
  }
  return drafts.map((d) => ({
    id: d.id,
    entryDate: d.entry_date,
    locationId: d.location_id,
    memo: d.memo,
    createdBy: d.created_by,
    createdByName: d.created_by_name,
    createdAt: d.created_at,
    lines: linesByDraft.get(d.id) ?? [],
  }));
}

/** Every pending draft (the review queue), newest first. */
export async function listDrafts(businessId: string): Promise<JournalDraft[]> {
  const { rows } = await query<DraftRow>(
    `SELECT d.id, d.entry_date::text AS entry_date, d.location_id, d.memo, d.created_by, u.full_name AS created_by_name, d.created_at::text AS created_at
       FROM journal_entry_drafts d LEFT JOIN users u ON u.id = d.created_by
      WHERE d.business_id = $1
      ORDER BY d.created_at DESC`,
    [businessId],
  );
  return attachLines(businessId, rows);
}

export async function getDraft(
  businessId: string,
  id: string,
): Promise<JournalDraft | null> {
  const { rows } = await query<DraftRow>(
    `SELECT d.id, d.entry_date::text AS entry_date, d.location_id, d.memo, d.created_by, u.full_name AS created_by_name, d.created_at::text AS created_at
       FROM journal_entry_drafts d LEFT JOIN users u ON u.id = d.created_by
      WHERE d.business_id = $1 AND d.id = $2`,
    [businessId, id],
  );
  if (!rows[0]) return null;
  const [draft] = await attachLines(businessId, rows);
  return draft;
}

export async function createDraft(params: {
  businessId: string;
  locationId: string | null;
  entryDate?: string | null;
  memo: string;
  lines: DraftLineInput[];
  createdBy: string;
}): Promise<{ id: string }> {
  const memo = typeof params.memo === "string" ? params.memo.trim() : "";
  if (!memo) throw new ManualJournalError("memo_required");
  const entryDate = normalizeEntryDate(params.entryDate);
  const nonZero = validatedNonZeroLines(params.lines);
  await assertAccountsOwned(
    params.businessId,
    nonZero.map((l) => l.accountId),
  );

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entry_drafts (business_id, location_id, entry_date, memo, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [params.businessId, params.locationId, entryDate, memo, params.createdBy],
    );
    const draftId = rows[0].id;
    for (const l of nonZero) {
      await client.query(
        `INSERT INTO journal_entry_draft_lines (draft_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)`,
        [draftId, l.accountId, l.debit, l.credit],
      );
    }
    await client.query("COMMIT");
    return { id: draftId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Discards a draft — it never had any financial effect, so unlike a posted entry there's nothing to keep visible. */
export async function deleteDraft(
  businessId: string,
  id: string,
): Promise<void> {
  const { rowCount } = await query(
    `DELETE FROM journal_entry_drafts WHERE id = $1 AND business_id = $2`,
    [id, businessId],
  );
  if (!rowCount) throw new ManualJournalError("draft_not_found", 404);
}

/** Approves a draft: posts it as a real journal entry (through the normal fiscal-period-checked path) and removes the draft. */
export async function approveDraft(params: {
  businessId: string;
  /** Kept for API compatibility; the posted entry uses the draft's own location. */
  locationId: string | null;
  draftId: string;
  actorId: string;
}): Promise<{ entryId: string }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<DraftRow>(
      `SELECT d.id, d.entry_date::text AS entry_date, d.location_id, d.memo, d.created_by,
              u.full_name AS created_by_name, d.created_at::text AS created_at
         FROM journal_entry_drafts d LEFT JOIN users u ON u.id = d.created_by
        WHERE d.business_id = $1 AND d.id = $2
        FOR UPDATE OF d`,
      [params.businessId, params.draftId],
    );
    if (!rows[0]) throw new ManualJournalError("draft_not_found", 404);
    const [draft] = await attachLines(params.businessId, rows, client);

    // Re-validated at approval time, not just draft creation: an account the
    // draft referenced may have been edited or removed since.
    const nonZero = validatedNonZeroLines(draft.lines);
    await assertAccountsOwned(
      params.businessId,
      nonZero.map((l) => l.accountId),
      client,
    );

    const entryId = await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: draft.locationId,
      entryDate: draft.entryDate,
      memo: draft.memo,
      sourceType: "manual",
      sourceId: null,
      createdBy: params.actorId,
      lines: nonZero as JournalLine[],
    });
    const { rowCount } = await client.query(
      `DELETE FROM journal_entry_drafts WHERE id = $1 AND business_id = $2`,
      [params.draftId, params.businessId],
    );
    if (!rowCount) throw new ManualJournalError("draft_not_found", 404);
    await client.query("COMMIT");
    return { entryId: entryId! };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reverses a posted manual entry: a new entry with every line's debit and
 * credit swapped, dated whenever it's recorded (not backdated into the
 * original's period). Only a manual entry may be reversed — an auto-posted
 * one (an order payment, a purchase receipt, …) already has its own
 * correction flow (a void, a refund, a return).
 */
export async function reverseEntry(params: {
  businessId: string;
  /** Kept for API compatibility; the reversal uses the original entry's location. */
  locationId: string | null;
  entryId: string;
  actorId: string;
  memo?: string | null;
  entryDate?: string | null;
}): Promise<{ entryId: string }> {
  const entryDate = normalizeEntryDate(params.entryDate);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: entryRows } = await client.query<{
      id: string;
      location_id: string | null;
      source_type: string | null;
      memo: string | null;
      reverses_entry_id: string | null;
      reversed_at: string | null;
    }>(
      `SELECT id, location_id, source_type, memo, reverses_entry_id, reversed_at::text AS reversed_at
         FROM journal_entries
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [params.entryId, params.businessId],
    );
    const original = entryRows[0];
    if (!original) throw new ManualJournalError("entry_not_found", 404);
    if (original.source_type !== "manual")
      throw new ManualJournalError("not_reversible", 409);
    if (original.reverses_entry_id)
      throw new ManualJournalError("cannot_reverse_a_reversal", 409);
    if (original.reversed_at)
      throw new ManualJournalError("already_reversed", 409);

    const { rows: lineRows } = await client.query<{
      account_id: string;
      debit: string;
      credit: string;
    }>(
      `SELECT account_id, debit::text AS debit, credit::text AS credit FROM journal_lines WHERE entry_id = $1 ORDER BY id`,
      [params.entryId],
    );
    if (lineRows.length === 0)
      throw new ManualJournalError("entry_has_no_lines", 409);

    const entryId = await postExactJournalEntry(client, {
      businessId: params.businessId,
      locationId: original.location_id,
      entryDate,
      memo:
        (typeof params.memo === "string" ? params.memo.trim() : "") ||
        `برگشت سند: ${original.memo ?? ""}`.trim(),
      sourceType: "manual",
      sourceId: null,
      createdBy: params.actorId,
      lines: lineRows.map((l) => ({
        accountId: l.account_id,
        debit: l.credit as RialText,
        credit: l.debit as RialText,
      })),
    });
    await client.query(
      `UPDATE journal_entries SET reverses_entry_id = $2 WHERE id = $1`,
      [entryId, params.entryId],
    );
    await client.query(
      `UPDATE journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1`,
      [params.entryId, params.actorId],
    );
    await client.query("COMMIT");
    return { entryId: entryId! };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
