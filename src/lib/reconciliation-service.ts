/**
 * Phase 16 — bank & cash reconciliation.
 *
 * Reconciles one account (cash or bank-clearing — the only two accounts
 * anything in this system posts to) against a manually-entered statement
 * ending balance. A reconciliation's candidate lines are every journal line
 * ever posted to the account, up to the statement date, that no earlier
 * *completed* reconciliation has already claimed — so "unreconciled items
 * carry forward" is just what's left unclaimed, not a separate step.
 * Completing a reconciliation requires its opening balance (the last
 * completed reconciliation's statement balance, or 0 for the first one)
 * plus the sum of its cleared lines to match the statement balance exactly,
 * and locks every cleared line: they can never be un-cleared or claimed by
 * a later reconciliation.
 *
 * DB-touching, so per repo convention it has no direct unit test. Covered
 * by integration/reconciliation.integration.test.ts.
 */
import { getPool, query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";

export type ReconcilableAccount = "cash" | "bankClearing";

const ACCOUNT_CODES: Record<ReconcilableAccount, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bankClearing: WELL_KNOWN_CODES.bankClearing,
};

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
    [businessId, ACCOUNT_CODES[accountCode]],
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
    accountCode: r.account_code === ACCOUNT_CODES.cash ? "cash" : "bankClearing",
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
 * The most recent *other* completed reconciliation's statement balance for
 * this account, or 0 if there isn't one. Excludes `excludeId` (the
 * reconciliation this balance is being computed for) — otherwise, once that
 * reconciliation is itself completed, it would match its own "most recent
 * completed" query and double-count against itself.
 */
async function openingBalance(businessId: string, accountId: string, excludeId: string): Promise<number> {
  const { rows } = await query<{ statement_balance: string }>(
    `SELECT statement_balance::text AS statement_balance FROM bank_reconciliations
      WHERE business_id = $1 AND account_id = $2 AND status = 'completed' AND id <> $3
      ORDER BY statement_date DESC, completed_at DESC LIMIT 1`,
    [businessId, accountId, excludeId],
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
    openingBalance(businessId, row.account_id, row.id),
    candidateLines(businessId, row.account_id, id, row.statement_date),
  ]);
  const clearedTotal = lines.filter((l) => l.cleared).reduce((sum, l) => sum + l.debit - l.credit, 0);
  const computedBalance = opening + clearedTotal;
  const summary = toSummary(row);

  return {
    ...summary,
    openingBalance: opening,
    clearedTotal,
    computedBalance,
    difference: summary.statementBalance - computedBalance,
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

    const { rows } = await client.query<ReconciliationRow>(
      `INSERT INTO bank_reconciliations (business_id, account_id, statement_date, statement_balance, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, statement_date::text AS statement_date, statement_balance::text AS statement_balance,
                 status, completed_at::text AS completed_at`,
      [params.businessId, accountId, params.statementDate, params.statementBalance, params.createdBy],
    );
    await client.query("COMMIT");
    return toSummary({ ...rows[0], account_code: ACCOUNT_CODES[params.accountCode] });
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
  const { rows } = await query<{ id: string; account_id: string; status: string }>(
    `SELECT id, account_id, status FROM bank_reconciliations WHERE id = $1 AND business_id = $2`,
    [params.reconciliationId, params.businessId],
  );
  const reconciliation = rows[0];
  if (!reconciliation) throw new ReconciliationError("reconciliation_not_found", 404);
  if (reconciliation.status !== "in_progress") throw new ReconciliationError("reconciliation_completed", 409);

  const { rows: lineRows } = await query<{ id: string }>(
    `SELECT jl.id FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.id = $1 AND jl.account_id = $2 AND je.business_id = $3`,
    [params.journalLineId, reconciliation.account_id, params.businessId],
  );
  if (!lineRows[0]) throw new ReconciliationError("journal_line_not_found", 404);

  if (params.cleared) {
    await query(
      `INSERT INTO bank_reconciliation_lines (reconciliation_id, journal_line_id)
       VALUES ($1, $2) ON CONFLICT (journal_line_id) DO NOTHING`,
      [params.reconciliationId, params.journalLineId],
    );
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
  if (detail.status !== "in_progress") throw new ReconciliationError("reconciliation_completed", 409);
  if (detail.difference !== 0) throw new ReconciliationError("balance_mismatch", 409);

  await query(
    `UPDATE bank_reconciliations SET status = 'completed', completed_at = now(), completed_by = $2
      WHERE id = $1`,
    [params.reconciliationId, params.actorId],
  );
  return getReconciliation(params.businessId, params.reconciliationId);
}
