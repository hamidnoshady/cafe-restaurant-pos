/**
 * Phase 16 — year-end closing entries.
 *
 * Rolls a fiscal year's revenue/expense accounts into Retained Earnings
 * (WELL_KNOWN_CODES.retainedEarnings) and locks every one of its periods, in
 * one transaction. The closing entry itself is dated on the year's `ends_on`
 * and posted while the last period is still `soft_closed` (owner/accountant
 * may still post there per migration 0024's trigger) — the periods are only
 * locked *after* the entry is safely in, as the last step of the same
 * transaction, so there is no window where the trigger would need a special
 * case for the closing entry itself.
 *
 * DB-touching, so per repo convention it has no direct unit test — covered by
 * closing.integration.test.ts.
 */
import { getPool } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountIdsByCode, MissingLedgerAccountError, postJournalEntry } from "./ledger-service";
import { FiscalPeriodError } from "./fiscal-periods-service";
import { fiscalPeriodLockErrorCode } from "./fiscal-periods";
import type { JournalLine } from "./ledger";

export { MissingLedgerAccountError };

export interface CloseFiscalYearResult {
  fiscalYearId: string;
  closingEntryId: string | null;
  netIncome: number;
}

/**
 * Closes fiscal year `fiscalYearId`: every period must already be
 * `soft_closed` (not still open, and not already locked by some other path) —
 * that's the point at which the year's books are considered reviewed and
 * ready. Posts one closing entry (or none, if the year had no revenue/expense
 * activity at all) and locks every period.
 */
export async function closeFiscalYear(
  businessId: string,
  fiscalYearId: string,
  actorId: string,
): Promise<CloseFiscalYearResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: yearRows } = await client.query<{
      id: string;
      starts_on: string;
      ends_on: string;
      closed_at: string | null;
    }>(
      `SELECT id, starts_on::text AS starts_on, ends_on::text AS ends_on, closed_at
         FROM fiscal_years WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [fiscalYearId, businessId],
    );
    const year = yearRows[0];
    if (!year) throw new FiscalPeriodError("fiscal_year_not_found", 404);
    if (year.closed_at) throw new FiscalPeriodError("fiscal_year_already_closed", 409);

    const { rows: periods } = await client.query<{ status: string }>(
      `SELECT status::text AS status FROM fiscal_periods WHERE business_id = $1 AND fiscal_year_id = $2`,
      [businessId, fiscalYearId],
    );
    if (periods.length === 0 || periods.some((p) => p.status !== "soft_closed")) {
      throw new FiscalPeriodError("periods_not_ready", 409);
    }

    const { rows: totals } = await client.query<{
      account_id: string;
      account_type: "revenue" | "expense";
      debit: string;
      credit: string;
    }>(
      `SELECT a.id AS account_id, a.type::text AS account_type,
              SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.business_id = $1 AND a.type IN ('revenue', 'expense')
          AND je.entry_date BETWEEN $2 AND $3
        GROUP BY a.id, a.type
       HAVING SUM(jl.debit) <> SUM(jl.credit)`,
      [businessId, year.starts_on, year.ends_on],
    );

    const lines: JournalLine[] = [];
    let netIncome = 0;
    for (const r of totals) {
      const debit = Number(r.debit);
      const credit = Number(r.credit);
      if (r.account_type === "revenue") {
        const balance = credit - debit; // normal credit balance
        netIncome += balance;
        lines.push({ accountId: r.account_id, debit: Math.max(balance, 0), credit: Math.max(-balance, 0) });
      } else {
        const balance = debit - credit; // normal debit balance
        netIncome -= balance;
        lines.push({ accountId: r.account_id, debit: Math.max(-balance, 0), credit: Math.max(balance, 0) });
      }
    }

    if (netIncome !== 0) {
      const retainedEarnings = await accountIdsByCode(client, businessId, [WELL_KNOWN_CODES.retainedEarnings]);
      const retainedEarningsId = retainedEarnings.get(WELL_KNOWN_CODES.retainedEarnings)!;
      lines.push({
        accountId: retainedEarningsId,
        debit: Math.max(-netIncome, 0),
        credit: Math.max(netIncome, 0),
      });
    }

    let closingEntryId: string | null = null;
    try {
      closingEntryId = await postJournalEntry(client, {
        businessId,
        locationId: null,
        entryDate: year.ends_on,
        memo: "بستن حساب‌های سال مالی",
        sourceType: "closing",
        sourceId: fiscalYearId,
        lines,
        createdBy: actorId,
        postingKind: "closing",
      });
    } catch (err) {
      if (fiscalPeriodLockErrorCode(err)) throw new FiscalPeriodError("period_locked_for_closing", 409);
      throw err;
    }

    await client.query(
      `UPDATE fiscal_periods SET status = 'locked', locked_at = now(), locked_by = $3
         WHERE business_id = $1 AND fiscal_year_id = $2 AND status = 'soft_closed'`,
      [businessId, fiscalYearId, actorId],
    );
    await client.query(
      `UPDATE fiscal_years SET closed_at = now(), closed_by = $3 WHERE id = $1 AND business_id = $2`,
      [fiscalYearId, businessId, actorId],
    );

    await client.query("COMMIT");
    return { fiscalYearId, closingEntryId, netIncome };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
