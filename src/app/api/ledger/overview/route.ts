import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";

/**
 * The Accounting app's dashboard, in one call.
 *
 * Read-only, like the trial balance it reports beside: every number is
 * reconstructed from `journal_lines` (the same source the trial balance and
 * every KPI elsewhere reads), so the dashboard cannot disagree with the books.
 * The balances use each account's normal side — assets and expenses are
 * debit-normal, liabilities and revenue are credit-normal — so a positive
 * number always means "we have / we owe / we earned", never a signed ledger
 * figure the owner has to decode.
 *
 * Owner/manager/accountant only: it is the ledger's own door.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const { rows: accounts } = await query<{
    code: string;
    type: string;
    debit: string;
    credit: string;
  }>(
    `SELECT a.code, a.type,
            COALESCE(SUM(jl.debit), 0) AS debit,
            COALESCE(SUM(jl.credit), 0) AS credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
      WHERE a.business_id = $1 AND a.is_active
      GROUP BY a.id
      ORDER BY a.code`,
    [session.businessId],
  );

  const balance = (row: { debit: string; credit: string }, debitNormal: boolean) =>
    (Number(row.debit) - Number(row.credit)) * (debitNormal ? 1 : -1);

  let totalDebit = 0;
  let totalCredit = 0;
  let cashAndBank = 0;
  let receivables = 0;
  let payables = 0;
  let revenue = 0;
  let expenses = 0;

  // Cash and bank equivalents: صندوق (1100), بانک (1110), کارت‌خوان (1120) and تنخواه (1130).
  const CASH_CODES = new Set(["1100", "1110", "1120", "1130"]);

  for (const row of accounts) {
    const debit = Number(row.debit);
    const credit = Number(row.credit);
    totalDebit += debit;
    totalCredit += credit;
    if (CASH_CODES.has(row.code)) cashAndBank += balance(row, true);
    // حساب‌های دریافتنی و اسناد دریافتنی: the 12xx asset block.
    if (row.code.startsWith("12")) receivables += balance(row, true);
    // حساب‌های پرداختنی و اسناد پرداختنی: the 21xx liability block.
    if (row.code.startsWith("21")) payables += balance(row, false);
    if (row.type === "revenue") revenue += balance(row, false);
    if (row.type === "expense") expenses += balance(row, true);
  }

  const { rows: cheques } = await query<{ open_receivable: string; open_payable: string }>(
    `SELECT COUNT(*) FILTER (WHERE direction = 'receivable' AND status IN ('on_hand', 'in_collection', 'endorsed')) AS open_receivable,
            COUNT(*) FILTER (WHERE direction = 'payable' AND status = 'issued') AS open_payable
       FROM cheques
      WHERE business_id = $1`,
    [session.businessId],
  );

  const { rows: recent } = await query<{
    id: string;
    entry_date: string;
    memo: string | null;
    source_type: string | null;
    total: string;
  }>(
    `SELECT je.id, je.entry_date, je.memo, je.source_type,
            COALESCE(SUM(jl.debit), 0) AS total
       FROM journal_entries je
       LEFT JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.business_id = $1
      GROUP BY je.id
      ORDER BY je.posted_at DESC
      LIMIT 5`,
    [session.businessId],
  );

  return NextResponse.json({
    overview: {
      balanced: totalDebit === totalCredit,
      totalDebit,
      totalCredit,
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
    },
  });
});
