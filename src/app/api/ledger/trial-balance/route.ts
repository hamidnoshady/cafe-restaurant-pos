import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";

/**
 * Trial balance: every account's total debit/credit across all journal
 * lines. Since every posted entry is validated balanced (postJournalEntry /
 * the manual-entry route), the grand totals always match — this endpoint
 * surfaces that as a visible integrity check, not just an assumption.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const { rows: accounts } = await query<{
    id: string;
    code: string;
    name: string;
    type: string;
    debit: string;
    credit: string;
  }>(
    `SELECT a.id, a.code, a.name, a.type,
            COALESCE(SUM(jl.debit), 0) AS debit,
            COALESCE(SUM(jl.credit), 0) AS credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
      WHERE a.business_id = $1 AND a.is_active
      GROUP BY a.id
      ORDER BY a.code`,
    [session.businessId],
  );

  const totalDebit = accounts.reduce((sum, a) => sum + Number(a.debit), 0);
  const totalCredit = accounts.reduce((sum, a) => sum + Number(a.credit), 0);

  return NextResponse.json({
    accounts,
    totalDebit,
    totalCredit,
    balanced: totalDebit === totalCredit,
  });
});
