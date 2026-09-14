/**
 * The two read-only reports the Accounting app opens on: the trial balance and
 * the app's own dashboard.
 *
 * Both were SQL inside their route handlers, which is why they drifted: each
 * carried its own copy of "which accounts count", and when one was fixed the
 * other was not. Per the repo layout rule DB-touching logic belongs in
 * `src/lib/*`, and having one module means the dashboard and the trial balance
 * cannot disagree about the same books — they now share
 * {@link accountTotals}.
 *
 * The load-bearing rule here is `ARCHIVED_WITH_POSTINGS`: an **archived
 * account still reports the postings it received**. Archiving an account only
 * stops it being offered for *new* entries — `accounts-service.ts` says so in
 * as many words ("a trial balance or statement still shows every posting an
 * archived account ever received") — so filtering the report on `is_active`
 * dropped one side of a real, balanced entry and made a correct book report
 * itself نامتوازن. An archived account with no postings is still left out: that
 * is noise, not history.
 *
 * DB-touching, so per repo convention no direct unit test; covered by
 * integration/ledger-reports.integration.test.ts.
 */
import { query } from "./db";

export type AccountType =
  "asset" | "liability" | "equity" | "revenue" | "expense";

interface AccountTotalRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  is_active: boolean;
  debit: string;
  credit: string;
}

interface LedgerIntegrityRow extends Record<string, unknown> {
  entry_count: string;
  line_count: string;
  total_debit: string;
  total_credit: string;
  balance_difference: string;
  unbalanced_entry_count: string;
  invalid_entry_count: string;
  balanced: boolean;
}

interface LedgerIntegritySummary {
  entryCount: number;
  lineCount: number;
  totalDebit: number;
  totalCredit: number;
  balanceDifference: number;
  unbalancedEntryCount: number;
  invalidEntryCount: number;
  balanced: boolean;
}

/**
 * Every account that belongs in a report, with its lifetime debit and credit
 * totals: the active chart, plus any archived account that carries postings.
 */
async function accountTotals(businessId: string): Promise<AccountTotalRow[]> {
  const { rows } = await query<AccountTotalRow>(
    `SELECT a.id, a.code, a.name, a.type, a.is_active,
            COALESCE(SUM(jl.debit), 0)::text AS debit,
            COALESCE(SUM(jl.credit), 0)::text AS credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
      WHERE a.business_id = $1
      GROUP BY a.id
     HAVING a.is_active OR COUNT(jl.id) > 0
      ORDER BY a.code`,
    [businessId],
  );
  return rows;
}

/**
 * Ledger health is an entry-level question, not only a grand-total question.
 *
 * The old dashboard did `SUM(debit) === SUM(credit)` over account totals. That
 * has two dangerous false positives: an empty ledger (0 = 0) and two broken
 * entries whose differences cancel each other out. This summary keeps those
 * states separate so the UI can say «بدون سند» or «نامتوازن» instead of a
 * green, fake all-clear.
 */
async function ledgerIntegritySummary(
  businessId: string,
): Promise<LedgerIntegritySummary> {
  const { rows } = await query<LedgerIntegrityRow>(
    `WITH per_entry AS (
       SELECT je.id,
              COUNT(jl.id)::bigint AS line_count,
              COALESCE(SUM(jl.debit), 0) AS debit,
              COALESCE(SUM(jl.credit), 0) AS credit
         FROM journal_entries je
         LEFT JOIN journal_lines jl ON jl.entry_id = je.id
        WHERE je.business_id = $1
        GROUP BY je.id
     )
     SELECT COUNT(*)::text AS entry_count,
            COALESCE(SUM(line_count), 0)::text AS line_count,
            COALESCE(SUM(debit), 0)::text AS total_debit,
            COALESCE(SUM(credit), 0)::text AS total_credit,
            (COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0))::text AS balance_difference,
            COUNT(*) FILTER (WHERE debit <> credit)::text AS unbalanced_entry_count,
            COUNT(*) FILTER (WHERE line_count < 2)::text AS invalid_entry_count,
            (COUNT(*) > 0
              AND COUNT(*) FILTER (WHERE line_count < 2) = 0
              AND COUNT(*) FILTER (WHERE debit <> credit) = 0
              AND COALESCE(SUM(debit), 0) = COALESCE(SUM(credit), 0)) AS balanced
       FROM per_entry`,
    [businessId],
  );

  const row = rows[0];
  return {
    entryCount: Number(row?.entry_count ?? 0),
    lineCount: Number(row?.line_count ?? 0),
    totalDebit: Number(row?.total_debit ?? 0),
    totalCredit: Number(row?.total_credit ?? 0),
    balanceDifference: Number(row?.balance_difference ?? 0),
    unbalancedEntryCount: Number(row?.unbalanced_entry_count ?? 0),
    invalidEntryCount: Number(row?.invalid_entry_count ?? 0),
    balanced: row?.balanced ?? false,
  };
}

function accountCodeNumber(code: string): number | null {
  // The system templates use ASCII digit account codes. Treat any decorated or
  // free-form code as outside a numeric range rather than guessing.
  if (!/^\d+$/.test(code)) return null;
  const value = Number(code);
  return Number.isSafeInteger(value) ? value : null;
}

function accountCodeInRange(code: string, start: number, end: number): boolean {
  const value = accountCodeNumber(code);
  return value !== null && value >= start && value <= end;
}

export interface TrialBalanceRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  /** False for an archived account. It still reports the postings it received. */
  isActive: boolean;
  debit: string;
  credit: string;
}

export interface TrialBalance {
  accounts: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
  /** Posted journal entries. Zero means there is nothing to call balanced yet. */
  entryCount: number;
  lineCount: number;
  /** Entries whose debit and credit totals differ, even if the grand totals cancel out. */
  unbalancedEntryCount: number;
  /** Persisted journal entries with fewer than two lines. */
  invalidEntryCount: number;
  /** debit − credit across posted journal lines. */
  balanceDifference: number;
}

/**
 * Every account's total debit/credit across all journal lines. The posting
 * services validate new entries, but imported or hand-repaired data can still be
 * bad, so the health flag is checked at the journal-entry level rather than
 * inferred from a grand total.
 */
export async function getTrialBalance(
  businessId: string,
): Promise<TrialBalance> {
  const [rows, integrity] = await Promise.all([
    accountTotals(businessId),
    ledgerIntegritySummary(businessId),
  ]);
  return {
    accounts: rows.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      isActive: a.is_active,
      debit: a.debit,
      credit: a.credit,
    })),
    totalDebit: integrity.totalDebit,
    totalCredit: integrity.totalCredit,
    balanced: integrity.balanced,
    entryCount: integrity.entryCount,
    lineCount: integrity.lineCount,
    unbalancedEntryCount: integrity.unbalancedEntryCount,
    invalidEntryCount: integrity.invalidEntryCount,
    balanceDifference: integrity.balanceDifference,
  };
}

export interface LedgerOverview {
  balanced: boolean;
  totalDebit: number;
  totalCredit: number;
  /** Posted journal entries. Zero means there is nothing to call balanced yet. */
  journalEntryCount: number;
  journalLineCount: number;
  /** Entries whose debit and credit totals differ, even if the grand totals cancel out. */
  unbalancedEntryCount: number;
  /** Persisted journal entries with fewer than two lines. */
  invalidEntryCount: number;
  /** debit − credit across posted journal lines. */
  balanceDifference: number;
  cashAndBank: number;
  receivables: number;
  payables: number;
  revenue: number;
  expenses: number;
  netIncome: number;
  openReceivableCheques: number;
  openPayableCheques: number;
  recentEntries: {
    id: string;
    date: string;
    memo: string | null;
    sourceType: string | null;
    total: number;
  }[];
}

/** Cash and bank equivalents: the 1100–1130 block (صندوق، بانک، کارت‌خوان، تنخواه and their custom sub-accounts). */
const CASH_AND_BANK_CODE_START = 1100;
const CASH_AND_BANK_CODE_END = 1130;

/**
 * The Accounting app's dashboard, in one read.
 *
 * The balances use each account's normal side — assets and expenses are
 * debit-normal, liabilities and revenue are credit-normal — so a positive
 * number always means "we have / we owe / we earned", never a signed ledger
 * figure the owner has to decode.
 */
export async function getLedgerOverview(
  businessId: string,
): Promise<LedgerOverview> {
  const [accounts, integrity] = await Promise.all([
    accountTotals(businessId),
    ledgerIntegritySummary(businessId),
  ]);

  const balance = (row: AccountTotalRow, debitNormal: boolean) =>
    (Number(row.debit) - Number(row.credit)) * (debitNormal ? 1 : -1);

  let cashAndBank = 0;
  let receivables = 0;
  let payables = 0;
  let revenue = 0;
  let expenses = 0;

  for (const row of accounts) {
    if (
      accountCodeInRange(
        row.code,
        CASH_AND_BANK_CODE_START,
        CASH_AND_BANK_CODE_END,
      )
    ) {
      cashAndBank += balance(row, true);
    }
    // حساب‌های دریافتنی و اسناد دریافتنی: the 12xx asset block.
    if (row.code.startsWith("12")) receivables += balance(row, true);
    // حساب‌های پرداختنی و اسناد پرداختنی: the 21xx liability block.
    if (row.code.startsWith("21")) payables += balance(row, false);
    if (row.type === "revenue") revenue += balance(row, false);
    if (row.type === "expense") expenses += balance(row, true);
  }

  const { rows: cheques } = await query<{
    open_receivable: string;
    open_payable: string;
  }>(
    `SELECT COUNT(*) FILTER (WHERE direction = 'receivable' AND status IN ('on_hand', 'in_collection', 'endorsed')) AS open_receivable,
            COUNT(*) FILTER (WHERE direction = 'payable' AND status = 'issued') AS open_payable
       FROM cheques
      WHERE business_id = $1`,
    [businessId],
  );

  // `posted_at`, not `entry_date`: this list answers "what was entered last",
  // which is a different question from the journal's "what happened when".
  const { rows: recent } = await query<{
    id: string;
    entry_date: string;
    memo: string | null;
    source_type: string | null;
    total: string;
  }>(
    `SELECT je.id, je.entry_date::text AS entry_date, je.memo, je.source_type,
            COALESCE(SUM(jl.debit), 0) AS total
       FROM journal_entries je
       LEFT JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.business_id = $1
      GROUP BY je.id
      ORDER BY je.posted_at DESC
      LIMIT 5`,
    [businessId],
  );

  return {
    balanced: integrity.balanced,
    totalDebit: integrity.totalDebit,
    totalCredit: integrity.totalCredit,
    journalEntryCount: integrity.entryCount,
    journalLineCount: integrity.lineCount,
    unbalancedEntryCount: integrity.unbalancedEntryCount,
    invalidEntryCount: integrity.invalidEntryCount,
    balanceDifference: integrity.balanceDifference,
    cashAndBank,
    receivables,
    payables,
    revenue,
    expenses,
    netIncome: revenue - expenses,
    openReceivableCheques: Number(cheques[0]?.open_receivable ?? 0),
    openPayableCheques: Number(cheques[0]?.open_payable ?? 0),
    recentEntries: recent.map((entry) => ({
      id: entry.id,
      date: entry.entry_date,
      memo: entry.memo,
      sourceType: entry.source_type,
      total: Number(entry.total),
    })),
  };
}
