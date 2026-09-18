/**
 * Phase 16 — bank & cash reconciliation.
 *
 * Reconciles one settlement account against a manually-entered statement
 * ending balance. Three accounts qualify: صندوق (`cash`), بانک (`bank`) and
 * کارت‌خوان در راه (`bankClearing`). `bank` was missing until now, from a time
 * when nothing posted to it — but since Phase 30 a cheque *clears into the
 * bank* (cheques-service.ts posts 1110 on `clear`/`present`), so a business
 * that takes cheques had movements on 1110 and no way to reconcile the very
 * account «تطبیق بانکی» is named after. A reconciliation's candidate lines are every journal line
 * ever posted to the account, up to the statement date, that no earlier
 * *completed* reconciliation has already claimed — so "unreconciled items
 * carry forward" is just what's left unclaimed, not a separate step.
 * Completing a reconciliation requires its opening balance (the last
 * completed reconciliation's statement balance, or 0 for the first one)
 * plus the sum of its cleared lines to match the statement balance exactly,
 * and locks every cleared line: they can never be un-cleared or claimed by
 * a later reconciliation.
 *
 * DB-touching, so per repo convention it has no direct unit test. The rules it
 * enforces that *can* be stated without a database live in
 * `bank-reconciliation.ts` (unit-tested there, and shared with the screen so
 * the «مغایرت» a person reads and the one the server refuses to lock on are
 * the same computation). The rest is covered by
 * integration/reconciliation.integration.test.ts.
 */
import { getPool, query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { isUuid } from "./uuid";
import {
  canComplete,
  clearedTotalOf,
  computedBalanceOf,
  differenceOf,
  isLineWithinStatementWindow,
  isPlausibleStatementDate,
} from "./bank-reconciliation";

export type ReconcilableAccount = "cash" | "bank" | "bankClearing";

export const RECONCILABLE_ACCOUNTS: readonly ReconcilableAccount[] = ["cash", "bank", "bankClearing"];

/** Exported so the assistant's own «تطبیق نشده» tool reads the same three accounts. */
export const RECONCILABLE_ACCOUNT_CODES: Record<ReconcilableAccount, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bank,
  bankClearing: WELL_KNOWN_CODES.bankClearing,
};

/**
 * code → key, so a third account cannot be mislabelled as the fallback. The
 * two-way ternary this replaced read "cash, else bankClearing", which would
 * have reported every بانک reconciliation as a کارت‌خوان one.
 */
const ACCOUNT_KEYS_BY_CODE = new Map<string, ReconcilableAccount>(
  RECONCILABLE_ACCOUNTS.map((key) => [RECONCILABLE_ACCOUNT_CODES[key], key]),
);

export class ReconciliationError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

async function resolveAccountId(businessId: string, accountCode: ReconcilableAccount): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
    [businessId, RECONCILABLE_ACCOUNT_CODES[accountCode]],
  );
  if (!rows[0]) throw new ReconciliationError("ledger_account_missing", 409);
  return rows[0].id;
}

export interface ReconciliationSummary {
  id: string;
  accountCode: ReconcilableAccount;
  statementDate: string;
  statementBalance: number;
  status: "in_progress" | "completed";
  completedAt: string | null;
}

interface ReconciliationRow extends Record<string, unknown> {
  id: string;
  account_code: string;
  statement_date: string;
  statement_balance: string;
  status: "in_progress" | "completed";
  completed_at: string | null;
}

function toSummary(r: ReconciliationRow): ReconciliationSummary {
  return {
    id: r.id,
    accountCode: ACCOUNT_KEYS_BY_CODE.get(r.account_code) ?? "cash",
    statementDate: r.statement_date,
    statementBalance: Number(r.statement_balance),
    status: r.status,
    completedAt: r.completed_at,
  };
}

/** Every reconciliation for one account, newest first. */
export async function listReconciliations(
  businessId: string,
  accountCode: ReconcilableAccount,
): Promise<ReconciliationSummary[]> {
  const accountId = await resolveAccountId(businessId, accountCode);
  const { rows } = await query<ReconciliationRow>(
    `SELECT r.id, a.code AS account_code, r.statement_date::text AS statement_date,
            r.statement_balance::text AS statement_balance, r.status, r.completed_at::text AS completed_at
       FROM bank_reconciliations r JOIN accounts a ON a.id = r.account_id
      WHERE r.business_id = $1 AND r.account_id = $2
      ORDER BY r.statement_date DESC, r.created_at DESC`,
    [businessId, accountId],
  );
  return rows.map(toSummary);
}

/**
 * The statement balance this reconciliation opens from: the most recent
 * completed reconciliation *that ends on or before its own statement date*, or
 * 0 if there isn't one.
 *
 * Excludes `excludeId` (the reconciliation this balance is being computed for)
 * — otherwise, once that reconciliation is itself completed, it would match
 * its own "most recent completed" query and double-count against itself.
 *
 * The `statement_date <= $4` bound is the other half, and it is what makes a
 * *backdated* reconciliation correct. Without it the query took the newest
 * completed reconciliation on the account full stop, so starting a June
 * statement after July's had been locked opened June from July's closing
 * balance — a period opening from its own future. The «مغایرت» that produced
 * could only be cleared by ticking lines that had nothing to do with it.
 */
async function openingBalance(
  businessId: string,
  accountId: string,
  excludeId: string,
  statementDate: string,
): Promise<number> {
  const { rows } = await query<{ statement_balance: string }>(
    `SELECT statement_balance::text AS statement_balance FROM bank_reconciliations
      WHERE business_id = $1 AND account_id = $2 AND status = 'completed' AND id <> $3
        AND statement_date <= $4
      ORDER BY statement_date DESC, completed_at DESC LIMIT 1`,
    [businessId, accountId, excludeId, statementDate],
  );
  return rows[0] ? Number(rows[0].statement_balance) : 0;
}

export interface ReconciliationLine {
  journalLineId: string;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  debit: number;
  credit: number;
  cleared: boolean;
}

export interface ReconciliationDetail extends ReconciliationSummary {
  openingBalance: number;
  clearedTotal: number;
  computedBalance: number;
  difference: number;
  lines: ReconciliationLine[];
}

/** A candidate line: every posting to the account, up to the statement date, not already claimed by a *different* (necessarily completed) reconciliation. */
async function candidateLines(
  businessId: string,
  accountId: string,
  reconciliationId: string,
  statementDate: string,
): Promise<ReconciliationLine[]> {
  const { rows } = await query<{
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
      ORDER BY je.entry_date, je.posted_at`,
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

export async function getReconciliation(businessId: string, id: string): Promise<ReconciliationDetail> {
  // `WHERE id = $1` against a uuid column raises a syntax error rather than
  // returning no rows, which surfaced as a 500 and «خطای غیرمنتظره» instead of
  // an honest «تطبیق پیدا نشد» — see `isUuid`.
  if (!isUuid(id)) throw new ReconciliationError("reconciliation_not_found", 404);

  const { rows } = await query<ReconciliationRow>(
    `SELECT r.id, a.code AS account_code, r.statement_date::text AS statement_date,
            r.statement_balance::text AS statement_balance, r.status, r.completed_at::text AS completed_at,
            r.account_id
       FROM bank_reconciliations r JOIN accounts a ON a.id = r.account_id
      WHERE r.id = $1 AND r.business_id = $2`,
    [id, businessId],
  );
  const row = rows[0] as (ReconciliationRow & { account_id: string }) | undefined;
  if (!row) throw new ReconciliationError("reconciliation_not_found", 404);

  const [opening, lines] = await Promise.all([
    openingBalance(businessId, row.account_id, row.id, row.statement_date),
    candidateLines(businessId, row.account_id, id, row.statement_date),
  ]);
  // One definition of the sign and the arithmetic, shared with the screen
  // (`bank-reconciliation.ts`) so the two cannot disagree about «مغایرت».
  const clearedTotal = clearedTotalOf(lines);
  const computedBalance = computedBalanceOf(opening, clearedTotal);
  const summary = toSummary(row);

  return {
    ...summary,
    openingBalance: opening,
    clearedTotal,
    computedBalance,
    difference: differenceOf(summary.statementBalance, computedBalance),
    lines,
  };
}

export async function createReconciliation(params: {
  businessId: string;
  accountCode: ReconcilableAccount;
  statementDate: string;
  statementBalance: number;
  createdBy: string | null;
}): Promise<ReconciliationSummary> {
  if (!Number.isSafeInteger(params.statementBalance)) {
    throw new ReconciliationError("invalid_amount");
  }
  // A negative closing balance is refused per account rather than outright.
  // A till and a card-reader float are physical holdings: they cannot contain
  // less than nothing, so a minus there is a typo or a sign flip (entering the
  // period's movement instead of its closing balance), and it would otherwise
  // be accepted and then never reconcile. A *bank* account genuinely can be
  // overdrawn, so ۱۱۱۰ keeps the minus.
  if (params.statementBalance < 0 && params.accountCode !== "bank") {
    throw new ReconciliationError("negative_statement_balance");
  }
  // The wire format is ISO/Gregorian (the screen's JalaliDatePicker converts at
  // the boundary). Validated here rather than left to the `date` column, which
  // answered a malformed date with a 500; and a Jalali year that slipped
  // through un-converted was accepted as a *Gregorian* 1404 — a statement six
  // centuries back that no posting could ever match.
  if (!isPlausibleStatementDate(params.statementDate)) {
    throw new ReconciliationError("invalid_statement_date");
  }
  const statementDate = params.statementDate.trim();
  const accountId = await resolveAccountId(params.businessId, params.accountCode);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM bank_reconciliations WHERE account_id = $1 AND status = 'in_progress' FOR UPDATE`,
      [accountId],
    );
    if (existing[0]) {
      await client.query("ROLLBACK");
      throw new ReconciliationError("reconciliation_in_progress", 409);
    }

    // A reconciliation may not end on or before one that is already locked.
    //
    // Reconciliations on an account form a chain: each opens from the last
    // completed one's closing balance and claims the lines that one left. A
    // statement dated into a settled period has no honest place in that chain
    // — its candidate lines were already claimed and locked, so it opens from
    // a balance it cannot reach and can never be completed. It used to be
    // accepted silently and then sit as a permanently unclosable «تطبیق
    // ناتمام», blocking every new reconciliation on the account (only one may
    // be in progress). Refused up front instead.
    const { rows: locked } = await client.query<{ statement_date: string }>(
      `SELECT statement_date::text AS statement_date FROM bank_reconciliations
        WHERE account_id = $1 AND business_id = $2 AND status = 'completed' AND statement_date >= $3
        LIMIT 1`,
      [accountId, params.businessId, statementDate],
    );
    if (locked[0]) {
      await client.query("ROLLBACK");
      throw new ReconciliationError("statement_date_already_reconciled", 409);
    }

    const { rows } = await client.query<ReconciliationRow>(
      `INSERT INTO bank_reconciliations (business_id, account_id, statement_date, statement_balance, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, statement_date::text AS statement_date, statement_balance::text AS statement_balance,
                 status, completed_at::text AS completed_at`,
      [params.businessId, accountId, statementDate, params.statementBalance, params.createdBy],
    );
    await client.query("COMMIT");
    return toSummary({ ...rows[0], account_code: RECONCILABLE_ACCOUNT_CODES[params.accountCode] });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Clears or un-clears one journal line against an in-progress reconciliation. */
export async function setLineCleared(params: {
  businessId: string;
  reconciliationId: string;
  journalLineId: string;
  cleared: boolean;
}): Promise<void> {
  // See `getReconciliation`: a non-uuid id must be an honest 404, not a 500.
  if (!isUuid(params.reconciliationId)) throw new ReconciliationError("reconciliation_not_found", 404);
  // `journal_lines.id` is a bigint; anything else raises a syntax error the
  // same way a malformed uuid does.
  if (!/^\d+$/.test(params.journalLineId)) throw new ReconciliationError("journal_line_not_found", 404);

  const { rows } = await query<{
    id: string;
    account_id: string;
    status: string;
    statement_date: string;
  }>(
    `SELECT id, account_id, status, statement_date::text AS statement_date
       FROM bank_reconciliations WHERE id = $1 AND business_id = $2`,
    [params.reconciliationId, params.businessId],
  );
  const reconciliation = rows[0];
  if (!reconciliation) throw new ReconciliationError("reconciliation_not_found", 404);
  if (reconciliation.status !== "in_progress") throw new ReconciliationError("reconciliation_completed", 409);

  const { rows: lineRows } = await query<{ id: string; entry_date: string }>(
    `SELECT jl.id, je.entry_date::text AS entry_date
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.id = $1 AND jl.account_id = $2 AND je.business_id = $3`,
    [params.journalLineId, reconciliation.account_id, params.businessId],
  );
  const line = lineRows[0];
  if (!line) throw new ReconciliationError("journal_line_not_found", 404);

  // A reconciliation answers for the period ending on its statement date, and
  // `candidateLines` lists only lines up to that date — but this endpoint used
  // to accept *any* line on the account. A line posted after the statement
  // could therefore be claimed and locked by a reconciliation that would never
  // show it, and no later reconciliation could ever see it again: money
  // silently vanished from the reconcilable set. It is not a candidate, so it
  // is answered the same way a line on another account is.
  if (!isLineWithinStatementWindow(line.entry_date, reconciliation.statement_date)) {
    throw new ReconciliationError("journal_line_not_found", 404);
  }

  if (params.cleared) {
    // `ON CONFLICT DO NOTHING` used to swallow the one case that matters: the
    // line is already claimed by a *different* (necessarily completed)
    // reconciliation, which owns it for good. That returned «ok» while
    // changing nothing, so the tick appeared to take and then vanished on the
    // next read. Only a conflict with *this* reconciliation is genuinely a
    // no-op (a double-click, an offline retry).
    const { rowCount } = await query(
      `INSERT INTO bank_reconciliation_lines (reconciliation_id, journal_line_id)
       VALUES ($1, $2) ON CONFLICT (journal_line_id) DO NOTHING`,
      [params.reconciliationId, params.journalLineId],
    );
    if (!rowCount) {
      const { rows: owner } = await query<{ reconciliation_id: string }>(
        `SELECT reconciliation_id FROM bank_reconciliation_lines WHERE journal_line_id = $1`,
        [params.journalLineId],
      );
      if (owner[0] && owner[0].reconciliation_id !== params.reconciliationId) {
        throw new ReconciliationError("journal_line_already_reconciled", 409);
      }
    }
  } else {
    await query(
      `DELETE FROM bank_reconciliation_lines WHERE reconciliation_id = $1 AND journal_line_id = $2`,
      [params.reconciliationId, params.journalLineId],
    );
  }
}

/** Locks a reconciliation — only once its cleared lines exactly account for the statement balance. */
export async function completeReconciliation(params: {
  businessId: string;
  reconciliationId: string;
  actorId: string;
}): Promise<ReconciliationDetail> {
  const detail = await getReconciliation(params.businessId, params.reconciliationId);
  if (!canComplete(detail)) {
    throw detail.status !== "in_progress"
      ? new ReconciliationError("reconciliation_completed", 409)
      : new ReconciliationError("balance_mismatch", 409);
  }

  // `WHERE status = 'in_progress'` makes the lock itself the check: two
  // requests that both read a balanced reconciliation would otherwise both
  // pass the guard above and both UPDATE, and the second would overwrite
  // `completed_at`/`completed_by` — the audit trail would name whoever
  // finished second. Now exactly one wins and the loser is told the truth.
  const { rowCount } = await query(
    `UPDATE bank_reconciliations SET status = 'completed', completed_at = now(), completed_by = $2
      WHERE id = $1 AND business_id = $3 AND status = 'in_progress'`,
    [params.reconciliationId, params.actorId, params.businessId],
  );
  if (!rowCount) throw new ReconciliationError("reconciliation_completed", 409);

  return getReconciliation(params.businessId, params.reconciliationId);
}

/**
 * Discard an in-progress reconciliation.
 *
 * Without this the screen had no way back from a typo. Only one
 * reconciliation may be in progress per account, there is no way to edit a
 * statement balance once entered, and a reconciliation whose difference can
 * never reach zero can never be completed — so a single mistyped closing
 * balance wedged the account permanently, and the only escape was SQL against
 * the production database.
 *
 * Only `in_progress` may be discarded: a completed reconciliation is the
 * opening balance of the next one and an audit record of a period someone
 * signed off, so it is immutable here (`ON DELETE CASCADE` on
 * `bank_reconciliation_lines` merely releases this reconciliation's own
 * claims, returning those lines to the candidate pool for the next attempt).
 */
export async function discardReconciliation(params: {
  businessId: string;
  reconciliationId: string;
}): Promise<void> {
  if (!isUuid(params.reconciliationId)) {
    throw new ReconciliationError("reconciliation_not_found", 404);
  }

  // One statement: the status test rides along in the WHERE clause so a
  // completed reconciliation can never be deleted by a request that raced a
  // completion between the read and the write.
  const { rows } = await query<{ status: string }>(
    `DELETE FROM bank_reconciliations
      WHERE id = $1 AND business_id = $2 AND status = 'in_progress'
      RETURNING status`,
    [params.reconciliationId, params.businessId],
  );
  if (rows[0]) return;

  // Nothing was deleted: say which of the two reasons it was.
  const { rows: existing } = await query<{ status: string }>(
    `SELECT status FROM bank_reconciliations WHERE id = $1 AND business_id = $2`,
    [params.reconciliationId, params.businessId],
  );
  throw existing[0]
    ? new ReconciliationError("reconciliation_completed", 409)
    : new ReconciliationError("reconciliation_not_found", 404);
}
