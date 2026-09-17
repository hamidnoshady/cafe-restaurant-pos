/**
 * Phase 16 — bank & cash reconciliation («تطبیق بانکی و صندوق»).
 *
 * Reconciles one settlement account against a manually-entered statement
 * ending balance. Three accounts qualify: صندوق (`cash`), بانک (`bank`) and
 * کارت‌خوان در راه (`bankClearing`) — the set, their codes and their Persian
 * names live in `reconciliation.ts` so the screen, the assistant and this
 * service cannot disagree about them.
 *
 * A reconciliation's candidate lines are every journal line ever posted to the
 * account, up to the statement date, that no *other* reconciliation has
 * already claimed — so "unreconciled items carry forward" is just what's left
 * unclaimed, not a separate step. Completing a reconciliation requires its
 * opening balance (the last completed reconciliation's statement balance, or 0
 * for the first one) plus the sum of its cleared lines to match the statement
 * balance exactly, and locks every cleared line: they can never be un-cleared
 * or claimed by a later reconciliation.
 *
 * What this file learned the hard way, each guarded by a test in
 * `integration/reconciliation.integration.test.ts`:
 *
 *  - **The opening balance must come from the past.** It used to be "the most
 *    recent completed reconciliation other than this one", which for an older,
 *    already-completed reconciliation is one from its own *future*: reopening
 *    an April reconciliation after May was locked showed April opening with
 *    May's closing balance and a large invented «مغایرت».
 *  - **A line dated after the statement date may not be cleared.** The
 *    candidate list filters by date, but the PATCH endpoint took any line id on
 *    the account — and a claimed line that no reconciliation displays is
 *    excluded from every future one, permanently and invisibly.
 *  - **Completing has to be atomic.** It read the balances, then updated the
 *    row; two clicks (or two tabs) both passed the check and the second locked
 *    a reconciliation whose lines had moved underneath it.
 *  - **An in-progress reconciliation must be cancellable.** One started with
 *    the wrong date or balance can never balance and never be completed, and
 *    the unique index allows only one per account — so a typo used to brick
 *    the account's whole reconciliation screen with no way out.
 *  - **Ids are checked before they reach Postgres.** A non-uuid
 *    reconciliation id or a non-numeric journal line id raises
 *    `invalid input syntax`, which surfaced as a 500 and «خطای غیرمنتظره»
 *    instead of an honest 404.
 *
 * DB-touching, so per repo convention it has no direct unit test; the pure
 * half (`reconciliation.ts`) has one, and this half is covered by
 * `integration/reconciliation.integration.test.ts`.
 */
import { getPool, query } from "./db";
import { isUuid } from "./uuid";
import {
  isIsoDate,
  isJournalLineId,
  isStatementDateAfterLast,
  MAX_RECONCILIATION_LINE_BATCH,
  reconcilableAccountForCode,
  reconciliationBalances,
  RECONCILABLE_ACCOUNT_CODES,
  RECONCILABLE_ACCOUNT_META,
  RECONCILABLE_ACCOUNTS,
  type ReconciliationLine,
  type ReconcilableAccount,
} from "./reconciliation";

export {
  RECONCILABLE_ACCOUNTS,
  RECONCILABLE_ACCOUNT_CODES,
  RECONCILABLE_ACCOUNT_META,
  isReconcilableAccount,
  type ReconcilableAccount,
  type ReconciliationLine,
} from "./reconciliation";

export class ReconciliationError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

/**
 * Anything that can run a statement: the pool (the default) or a checked-out
 * client inside a transaction. `completeReconciliation` needs the *same*
 * connection that holds its `FOR UPDATE` lock to read the lines it is about to
 * lock, or the check it performs is against a snapshot another request can
 * still move.
 */
interface Querier {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

const pool: Querier = {
  query: (text, params) => query(text, params) as never,
};

async function resolveAccountId(
  businessId: string,
  accountCode: ReconcilableAccount,
  exec: Querier = pool,
): Promise<string> {
  const { rows } = await exec.query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
    [businessId, RECONCILABLE_ACCOUNT_CODES[accountCode]],
  );
  if (!rows[0]) throw new ReconciliationError("ledger_account_missing", 409);
  return rows[0].id;
}

export interface ReconciliationSummary {
  id: string;
  accountCode: ReconcilableAccount;
  /** The account's Persian name, so a list row never has to decode a key. */
  accountLabel: string;
  statementDate: string;
  statementBalance: number;
  status: "in_progress" | "completed";
  completedAt: string | null;
  createdAt: string | null;
  /** How many lines this reconciliation claims — the history's own «اقلام». */
  clearedCount: number;
}

interface ReconciliationRow extends Record<string, unknown> {
  id: string;
  account_code: string;
  statement_date: string;
  statement_balance: string;
  status: "in_progress" | "completed";
  completed_at: string | null;
  created_at?: string | null;
  cleared_count?: string | number | null;
}

function toSummary(r: ReconciliationRow): ReconciliationSummary {
  // Never a silent fallback to `cash`: a reconciliation whose account is not
  // one of the three is a data bug worth seeing, not one worth mislabelling.
  const accountCode = reconcilableAccountForCode(r.account_code);
  if (!accountCode) throw new ReconciliationError("invalid_account", 409);
  return {
    id: r.id,
    accountCode,
    accountLabel: RECONCILABLE_ACCOUNT_META[accountCode].label,
    statementDate: r.statement_date,
    statementBalance: Number(r.statement_balance),
    status: r.status,
    completedAt: r.completed_at,
    createdAt: r.created_at ?? null,
    clearedCount: Number(r.cleared_count ?? 0),
  };
}

/**
 * Every reconciliation for one account, newest first.
 *
 * `limit` is capped rather than unbounded: a business reconciling weekly for
 * five years has 260 rows, and the screen shows a page of them.
 */
export async function listReconciliations(
  businessId: string,
  accountCode: ReconcilableAccount,
  options: { limit?: number } = {},
): Promise<ReconciliationSummary[]> {
  const accountId = await resolveAccountId(businessId, accountCode);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const { rows } = await query<ReconciliationRow>(
    `SELECT r.id, a.code AS account_code, r.statement_date::text AS statement_date,
            r.statement_balance::text AS statement_balance, r.status,
            r.completed_at::text AS completed_at, r.created_at::text AS created_at,
            (SELECT count(*) FROM bank_reconciliation_lines brl WHERE brl.reconciliation_id = r.id) AS cleared_count
       FROM bank_reconciliations r JOIN accounts a ON a.id = r.account_id
      WHERE r.business_id = $1 AND r.account_id = $2
      ORDER BY r.statement_date DESC, r.created_at DESC
      LIMIT $3`,
    [businessId, accountId, limit],
  );
  return rows.map(toSummary);
}

/**
 * What the account looks like *before* a reconciliation is started.
 *
 * The screen used to offer an empty date field and an empty balance field with
 * nothing else on it: no hint of where the last statement left off, and no
 * sign of how much is waiting to be matched. All four numbers come from the
 * same place the reconciliation itself will read them from.
 */
export interface ReconciliationAccountOverview {
  accountCode: ReconcilableAccount;
  accountLabel: string;
  accountName: string;
  accountLedgerCode: string;
  /** The last completed reconciliation's statement balance — the next one's opening balance. */
  openingBalance: number;
  lastStatementDate: string | null;
  /** Every posting on the account, whether or not it has been reconciled. */
  ledgerBalance: number;
  unreconciledCount: number;
  unreconciledTotal: number;
}

export async function getAccountOverview(
  businessId: string,
  accountCode: ReconcilableAccount,
): Promise<ReconciliationAccountOverview> {
  const accountId = await resolveAccountId(businessId, accountCode);
  const [{ rows: lastRows }, { rows: balanceRows }, { rows: nameRows }] = await Promise.all([
    query<{ statement_balance: string; statement_date: string }>(
      `SELECT statement_balance::text AS statement_balance, statement_date::text AS statement_date
         FROM bank_reconciliations
        WHERE business_id = $1 AND account_id = $2 AND status = 'completed'
        ORDER BY statement_date DESC, completed_at DESC NULLS LAST, created_at DESC
        LIMIT 1`,
      [businessId, accountId],
    ),
    query<{ ledger_balance: string; unreconciled_count: string; unreconciled_total: string }>(
      `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS ledger_balance,
              COUNT(*) FILTER (WHERE brl.id IS NULL)::text AS unreconciled_count,
              COALESCE(SUM(jl.debit - jl.credit) FILTER (WHERE brl.id IS NULL), 0)::text AS unreconciled_total
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         LEFT JOIN bank_reconciliation_lines brl ON brl.journal_line_id = jl.id
        WHERE je.business_id = $1 AND jl.account_id = $2`,
      [businessId, accountId],
    ),
    query<{ name: string; code: string }>(`SELECT name, code FROM accounts WHERE id = $1`, [accountId]),
  ]);

  return {
    accountCode,
    accountLabel: RECONCILABLE_ACCOUNT_META[accountCode].label,
    accountName: nameRows[0]?.name ?? RECONCILABLE_ACCOUNT_META[accountCode].label,
    accountLedgerCode: nameRows[0]?.code ?? RECONCILABLE_ACCOUNT_CODES[accountCode],
    openingBalance: lastRows[0] ? Number(lastRows[0].statement_balance) : 0,
    lastStatementDate: lastRows[0]?.statement_date ?? null,
    ledgerBalance: Number(balanceRows[0]?.ledger_balance ?? 0),
    unreconciledCount: Number(balanceRows[0]?.unreconciled_count ?? 0),
    unreconciledTotal: Number(balanceRows[0]?.unreconciled_total ?? 0),
  };
}

/**
 * The opening balance for one reconciliation: the statement balance of the
 * last completed reconciliation that comes *before* it.
 *
 * "Before" is by statement date, with `created_at` breaking a same-day tie —
 * never merely "the most recent completed one that isn't this one", which for
 * an already-completed reconciliation reaches into its own future and reports
 * a difference that was never there.
 */
async function openingBalance(
  businessId: string,
  accountId: string,
  current: { id: string; statementDate: string; createdAt: string | null },
  exec: Querier = pool,
): Promise<number> {
  const { rows } = await exec.query<{ statement_balance: string }>(
    `SELECT statement_balance::text AS statement_balance FROM bank_reconciliations
      WHERE business_id = $1 AND account_id = $2 AND status = 'completed' AND id <> $3
        AND (statement_date < $4::date
             OR (statement_date = $4::date AND created_at < $5::timestamptz))
      ORDER BY statement_date DESC, created_at DESC LIMIT 1`,
    [businessId, accountId, current.id, current.statementDate, current.createdAt ?? new Date().toISOString()],
  );
  return rows[0] ? Number(rows[0].statement_balance) : 0;
}

export interface ReconciliationDetail extends ReconciliationSummary {
  openingBalance: number;
  clearedTotal: number;
  clearedCount: number;
  unclearedCount: number;
  unclearedTotal: number;
  debitTotal: number;
  creditTotal: number;
  computedBalance: number;
  difference: number;
  lines: ReconciliationLine[];
}

/** A candidate line: every posting to the account, up to the statement date, not already claimed by a *different* reconciliation. */
async function candidateLines(
  businessId: string,
  accountId: string,
  reconciliationId: string,
  statementDate: string,
  exec: Querier = pool,
): Promise<ReconciliationLine[]> {
  const { rows } = await exec.query<{
    journal_line_id: string;
    entry_date: string;
    memo: string | null;
    source_type: string | null;
    debit: string;
    credit: string;
    cleared: boolean;
  }>(
    `SELECT jl.id::text AS journal_line_id, je.entry_date::text AS entry_date, je.memo, je.source_type,
            jl.debit, jl.credit, (brl.id IS NOT NULL) AS cleared
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       LEFT JOIN bank_reconciliation_lines brl
              ON brl.journal_line_id = jl.id AND brl.reconciliation_id = $3
      WHERE jl.account_id = $2 AND je.business_id = $1 AND je.entry_date <= $4
        AND NOT EXISTS (
          SELECT 1 FROM bank_reconciliation_lines other
           WHERE other.journal_line_id = jl.id AND other.reconciliation_id <> $3
        )
      ORDER BY je.entry_date, je.posted_at, jl.id`,
    [businessId, accountId, reconciliationId, statementDate],
  );
  return rows.map((r) => ({
    journalLineId: r.journal_line_id,
    entryDate: r.entry_date,
    memo: r.memo,
    sourceType: r.source_type,
    debit: Number(r.debit),
    credit: Number(r.credit),
    cleared: r.cleared,
  }));
}

export async function getReconciliation(
  businessId: string,
  id: string,
  exec: Querier = pool,
): Promise<ReconciliationDetail> {
  if (!isUuid(id)) throw new ReconciliationError("reconciliation_not_found", 404);
  const { rows } = await exec.query<ReconciliationRow>(
    `SELECT r.id, a.code AS account_code, r.statement_date::text AS statement_date,
            r.statement_balance::text AS statement_balance, r.status, r.completed_at::text AS completed_at,
            r.created_at::text AS created_at, r.account_id
       FROM bank_reconciliations r JOIN accounts a ON a.id = r.account_id
      WHERE r.id = $1 AND r.business_id = $2`,
    [id, businessId],
  );
  const row = rows[0] as (ReconciliationRow & { account_id: string }) | undefined;
  if (!row) throw new ReconciliationError("reconciliation_not_found", 404);

  const summary = toSummary(row);
  // Sequential, not `Promise.all`: a checked-out client is a single connection
  // and cannot run two statements at once (the pool can, but this has to work
  // for both callers).
  const opening = await openingBalance(
    businessId,
    row.account_id,
    { id: row.id, statementDate: row.statement_date, createdAt: summary.createdAt },
    exec,
  );
  const lines = await candidateLines(businessId, row.account_id, id, row.statement_date, exec);
  const balances = reconciliationBalances({
    openingBalance: opening,
    statementBalance: summary.statementBalance,
    lines,
  });

  return { ...summary, openingBalance: opening, ...balances, lines };
}

export async function createReconciliation(params: {
  businessId: string;
  accountCode: ReconcilableAccount;
  statementDate: string;
  statementBalance: number;
  createdBy: string | null;
}): Promise<ReconciliationSummary> {
  if (!isIsoDate(params.statementDate)) throw new ReconciliationError("invalid_statement_date");
  if (!Number.isSafeInteger(params.statementBalance)) {
    throw new ReconciliationError("invalid_amount");
  }
  const accountId = await resolveAccountId(params.businessId, params.accountCode);

  const client = await getPool().connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM bank_reconciliations
        WHERE business_id = $1 AND account_id = $2 AND status = 'in_progress' FOR UPDATE`,
      [params.businessId, accountId],
    );
    if (existing[0]) throw new ReconciliationError("reconciliation_in_progress", 409);

    // A reconciliation dated before the last completed one would open with a
    // balance from its own future — the running total read backwards.
    const { rows: last } = await client.query<{ statement_date: string }>(
      `SELECT statement_date::text AS statement_date FROM bank_reconciliations
        WHERE business_id = $1 AND account_id = $2 AND status = 'completed'
        ORDER BY statement_date DESC LIMIT 1`,
      [params.businessId, accountId],
    );
    if (!isStatementDateAfterLast(params.statementDate, last[0]?.statement_date ?? null)) {
      throw new ReconciliationError("statement_date_before_last", 409);
    }

    const { rows } = await client.query<ReconciliationRow>(
      `INSERT INTO bank_reconciliations (business_id, account_id, statement_date, statement_balance, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, statement_date::text AS statement_date, statement_balance::text AS statement_balance,
                 status, completed_at::text AS completed_at, created_at::text AS created_at`,
      [params.businessId, accountId, params.statementDate, params.statementBalance, params.createdBy],
    );
    await client.query("COMMIT");
    inTransaction = false;
    return toSummary({ ...rows[0], account_code: RECONCILABLE_ACCOUNT_CODES[params.accountCode] });
  } catch (err) {
    // Only when one is actually open: rolling back twice logs a spurious
    // "no transaction in progress" warning on every rejected duplicate.
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The reconciliation a write is about, with the checks every write shares:
 * it exists, it belongs to this business, and it is still open.
 */
async function requireOpenReconciliation(
  businessId: string,
  reconciliationId: string,
): Promise<{ id: string; accountId: string; statementDate: string }> {
  if (!isUuid(reconciliationId)) throw new ReconciliationError("reconciliation_not_found", 404);
  const { rows } = await query<{
    id: string;
    account_id: string;
    status: string;
    statement_date: string;
  }>(
    `SELECT id, account_id, status, statement_date::text AS statement_date
       FROM bank_reconciliations WHERE id = $1 AND business_id = $2`,
    [reconciliationId, businessId],
  );
  const reconciliation = rows[0];
  if (!reconciliation) throw new ReconciliationError("reconciliation_not_found", 404);
  if (reconciliation.status !== "in_progress") throw new ReconciliationError("reconciliation_completed", 409);
  return {
    id: reconciliation.id,
    accountId: reconciliation.account_id,
    statementDate: reconciliation.statement_date,
  };
}

/** Clears or un-clears one journal line against an in-progress reconciliation. */
export async function setLineCleared(params: {
  businessId: string;
  reconciliationId: string;
  journalLineId: string;
  cleared: boolean;
}): Promise<void> {
  await setLinesCleared({
    businessId: params.businessId,
    reconciliationId: params.reconciliationId,
    journalLineIds: [params.journalLineId],
    cleared: params.cleared,
  });
}

/**
 * Clears or un-clears a *set* of lines in one statement.
 *
 * «انتخاب همه» on a month of card settlements is otherwise 300 sequential
 * PATCHes, each one re-reading the whole reconciliation — the screen's single
 * slowest act, and the one most likely to be interrupted half-done.
 */
export async function setLinesCleared(params: {
  businessId: string;
  reconciliationId: string;
  journalLineIds: readonly string[];
  cleared: boolean;
}): Promise<{ changed: number }> {
  const ids = Array.from(new Set(params.journalLineIds.map((id) => String(id).trim())));
  if (ids.length === 0) throw new ReconciliationError("journal_line_required");
  if (ids.length > MAX_RECONCILIATION_LINE_BATCH) throw new ReconciliationError("too_many_lines");
  // Checked before Postgres sees them: `WHERE jl.id = ANY($1::bigint[])` with a
  // non-numeric member raises a syntax error, i.e. a 500 where a 404 was meant.
  if (!ids.every(isJournalLineId)) throw new ReconciliationError("journal_line_not_found", 404);

  const reconciliation = await requireOpenReconciliation(params.businessId, params.reconciliationId);

  // Every id must be a line of *this* account, dated on or before the
  // statement date. A later-dated line is not merely invisible on this
  // screen — claiming it would exclude it from every future reconciliation
  // too, with nothing anywhere to show why.
  const { rows: lineRows } = await query<{ id: string }>(
    `SELECT jl.id::text AS id
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.id = ANY($1::bigint[]) AND jl.account_id = $2 AND je.business_id = $3
        AND je.entry_date <= $4::date`,
    [ids, reconciliation.accountId, params.businessId, reconciliation.statementDate],
  );
  if (lineRows.length !== ids.length) throw new ReconciliationError("journal_line_not_found", 404);

  if (params.cleared) {
    // `ON CONFLICT (journal_line_id) DO NOTHING` is what keeps a line claimed
    // by a *completed* reconciliation from being stolen by this one.
    const { rowCount } = await query(
      `INSERT INTO bank_reconciliation_lines (reconciliation_id, journal_line_id)
       SELECT $1, unnest($2::bigint[])
       ON CONFLICT (journal_line_id) DO NOTHING`,
      [params.reconciliationId, ids],
    );
    return { changed: rowCount ?? 0 };
  }
  const { rowCount } = await query(
    `DELETE FROM bank_reconciliation_lines
      WHERE reconciliation_id = $1 AND journal_line_id = ANY($2::bigint[])`,
    [params.reconciliationId, ids],
  );
  return { changed: rowCount ?? 0 };
}

/**
 * Locks a reconciliation — only once its cleared lines exactly account for the
 * statement balance.
 *
 * The row is locked `FOR UPDATE` and the balance re-checked inside the same
 * transaction as the update, so two clicks (or two tabs, or a tab and the
 * assistant) cannot both pass the check and lock a reconciliation whose lines
 * moved in between.
 */
export async function completeReconciliation(params: {
  businessId: string;
  reconciliationId: string;
  actorId: string;
}): Promise<ReconciliationDetail> {
  if (!isUuid(params.reconciliationId)) throw new ReconciliationError("reconciliation_not_found", 404);

  const client = await getPool().connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const { rows } = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM bank_reconciliations
        WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [params.reconciliationId, params.businessId],
    );
    if (!rows[0]) throw new ReconciliationError("reconciliation_not_found", 404);
    if (rows[0].status !== "in_progress") throw new ReconciliationError("reconciliation_completed", 409);

    // Read through the locked connection, so the balance being checked is the
    // one the UPDATE two lines below commits against.
    const detail = await getReconciliation(params.businessId, params.reconciliationId, client);
    if (detail.difference !== 0) throw new ReconciliationError("balance_mismatch", 409);

    await client.query(
      `UPDATE bank_reconciliations SET status = 'completed', completed_at = now(), completed_by = $2
        WHERE id = $1 AND business_id = $3 AND status = 'in_progress'`,
      [params.reconciliationId, params.actorId, params.businessId],
    );
    await client.query("COMMIT");
    inTransaction = false;
  } catch (err) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getReconciliation(params.businessId, params.reconciliationId);
}

/**
 * Cancels an in-progress reconciliation, releasing every line it had claimed.
 *
 * The unique index allows exactly one in-progress reconciliation per account,
 * and a completed one is immutable — so without this, a reconciliation opened
 * with the wrong statement date or balance (a mistyped «۱۴۰۴/۰۵/۳۱», a Rial
 * figure typed as Toman) can never be completed, never be replaced and never
 * be removed: the account's whole screen is stuck on a reconciliation nobody
 * can finish. Completed ones are refused here, which is the lock the whole
 * feature rests on.
 */
export async function deleteReconciliation(params: {
  businessId: string;
  reconciliationId: string;
}): Promise<void> {
  await requireOpenReconciliation(params.businessId, params.reconciliationId);
  // `bank_reconciliation_lines.reconciliation_id` is ON DELETE CASCADE, so the
  // claimed lines become candidates again the moment this row goes.
  await query(
    `DELETE FROM bank_reconciliations
      WHERE id = $1 AND business_id = $2 AND status = 'in_progress'`,
    [params.reconciliationId, params.businessId],
  );
}
