/**
 * Phase 16 — expense management, the DB-touching part.
 *
 * Categorised operating expenses recorded as paid, not owed — the AP
 * subledger already models a bill owed to a specific supplier; genericising
 * that to cover "money spent on rent" would blur two different things.
 * "Categorised" needs no new taxonomy: the expense account chosen (any
 * active type='expense' account — 5200-5900 in the default chart, or
 * whatever a business has customised it to via chart-of-accounts
 * management) is the category. Every expense posts a real, immediate
 * journal entry (Debit the expense account / Credit the payment account)
 * through the same postJournalEntry() every other posting path uses, so it
 * is subject to the fiscal-period lock exactly like everything else.
 *
 * DB-touching, so per repo convention it has no direct unit test. Covered by
 * integration/expense.integration.test.ts.
 */
import { getPool, query } from "./db";
import { postJournalEntry } from "./ledger-service";

export class ExpenseError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

async function assertAccount(businessId: string, accountId: string, expectedType: "expense" | "asset"): Promise<void> {
  const { rows } = await query<{ type: string }>(
    `SELECT type FROM accounts WHERE business_id = $1 AND id = $2 AND is_active`,
    [businessId, accountId],
  );
  if (!rows[0]) throw new ExpenseError("unknown_account");
  if (rows[0].type !== expectedType) {
    throw new ExpenseError(expectedType === "expense" ? "invalid_expense_account" : "invalid_payment_account");
  }
}

export interface Expense {
  id: string;
  expenseDate: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  paymentAccountId: string;
  paymentAccountCode: string;
  paymentAccountName: string;
  amount: number;
  vendor: string | null;
  memo: string;
  createdByName: string | null;
  createdAt: string;
}

interface ExpenseRow extends Record<string, unknown> {
  id: string;
  expense_date: string;
  account_id: string;
  account_code: string;
  account_name: string;
  payment_account_id: string;
  payment_account_code: string;
  payment_account_name: string;
  amount: string;
  vendor: string | null;
  memo: string;
  created_by_name: string | null;
  created_at: string;
}

function toExpense(r: ExpenseRow): Expense {
  return {
    id: r.id,
    expenseDate: r.expense_date,
    accountId: r.account_id,
    accountCode: r.account_code,
    accountName: r.account_name,
    paymentAccountId: r.payment_account_id,
    paymentAccountCode: r.payment_account_code,
    paymentAccountName: r.payment_account_name,
    amount: Number(r.amount),
    vendor: r.vendor,
    memo: r.memo,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
  };
}

const SELECT_EXPENSE = `
  SELECT e.id, e.expense_date::text AS expense_date, e.amount::text AS amount, e.vendor, e.memo, e.created_at::text AS created_at,
         e.account_id, a.code AS account_code, a.name AS account_name,
         e.payment_account_id, p.code AS payment_account_code, p.name AS payment_account_name,
         u.full_name AS created_by_name
    FROM expenses e
    JOIN accounts a ON a.id = e.account_id
    JOIN accounts p ON p.id = e.payment_account_id
    LEFT JOIN users u ON u.id = e.created_by`;

export async function listExpenses(businessId: string): Promise<Expense[]> {
  const { rows } = await query<ExpenseRow>(
    `${SELECT_EXPENSE} WHERE e.business_id = $1 ORDER BY e.expense_date DESC, e.created_at DESC LIMIT 200`,
    [businessId],
  );
  return rows.map(toExpense);
}

export async function recordExpense(params: {
  businessId: string;
  locationId: string | null;
  accountId: string;
  paymentAccountId: string;
  amount: number;
  expenseDate?: string | null;
  vendor?: string | null;
  memo: string;
  createdBy: string | null;
}): Promise<Expense> {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) throw new ExpenseError("invalid_amount");
  if (!params.memo.trim()) throw new ExpenseError("memo_required");
  if (params.accountId === params.paymentAccountId) throw new ExpenseError("same_account");

  await assertAccount(params.businessId, params.accountId, "expense");
  await assertAccount(params.businessId, params.paymentAccountId, "asset");

  let expenseId = "";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO expenses (business_id, location_id, account_id, payment_account_id, amount, expense_date, vendor, memo, created_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7, $8, $9) RETURNING id`,
      [
        params.businessId,
        params.locationId,
        params.accountId,
        params.paymentAccountId,
        params.amount,
        params.expenseDate?.trim() || null,
        params.vendor?.trim() || null,
        params.memo.trim(),
        params.createdBy,
      ],
    );
    expenseId = rows[0].id;

    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: params.expenseDate ?? null,
      memo: params.memo.trim(),
      sourceType: "expense",
      sourceId: expenseId,
      createdBy: params.createdBy,
      lines: [
        { accountId: params.accountId, debit: params.amount, credit: 0 },
        { accountId: params.paymentAccountId, debit: 0, credit: params.amount },
      ],
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const { rows: expenseRows } = await query<ExpenseRow>(`${SELECT_EXPENSE} WHERE e.id = $1`, [expenseId]);
  return toExpense(expenseRows[0]);
}
