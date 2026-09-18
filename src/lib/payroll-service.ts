/**
 * Phase 16 — payroll entries, the DB-touching part.
 *
 * Journal-level only, not a payroll engine: no tax tables, insurance, or
 * payslips. A run accrues (Debit salariesExpense / Credit salariesPayable)
 * against every active staff member's current `monthly_wage`, snapshotting
 * each person's amount into payroll_run_lines so the total stays auditable
 * even after wages change later — then paying it posts the other half
 * (Debit salariesPayable / Credit Cash/Bank-Clearing). Both go through the
 * same postJournalEntry() every other posting path uses, so both are
 * subject to the fiscal-period lock.
 *
 * DB-touching, so per repo convention it has no direct unit test. Covered by
 * integration/payroll.integration.test.ts.
 */
import { getPool, query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { normalizeOptionalIsoDate } from "./iso-date";
import { isUuid } from "./uuid";
import {
  accountIdsByCode,
  MissingLedgerAccountError,
  postExactMirrorEntry,
  postJournalEntry,
} from "./ledger-service";

export { MissingLedgerAccountError };

export class PayrollError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

/** The longest «دوره» heading a run may carry — a label, not a document. */
export const PERIOD_LABEL_MAX = 120;

export interface StaffWage {
  id: string;
  fullName: string;
  role: string;
  monthlyWage: number | null;
}

export async function listStaffWages(businessId: string): Promise<StaffWage[]> {
  const { rows } = await query<{ id: string; full_name: string; role: string; monthly_wage: string | null }>(
    `SELECT id, full_name, role, monthly_wage::text AS monthly_wage
       FROM users WHERE business_id = $1 AND is_active ORDER BY full_name`,
    [businessId],
  );
  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    role: r.role,
    monthlyWage: r.monthly_wage === null ? null : Number(r.monthly_wage),
  }));
}

export async function setWage(businessId: string, userId: string, monthlyWage: number | null): Promise<void> {
  // `users.id` is a uuid: `WHERE id = $1` against a non-uuid raises
  // `invalid input syntax for type uuid` rather than matching no row — a 500
  // and «خطای غیرمنتظره» where an honest 404 belongs. See `isUuid`.
  if (!isUuid(userId)) throw new PayrollError("user_not_found", 404);
  if (monthlyWage !== null && (typeof monthlyWage !== "number" || !Number.isSafeInteger(monthlyWage) || monthlyWage < 0)) {
    throw new PayrollError("invalid_amount");
  }
  const { rowCount } = await query(
    `UPDATE users SET monthly_wage = $1 WHERE id = $2 AND business_id = $3 AND is_active`,
    [monthlyWage, userId, businessId],
  );
  if (!rowCount) throw new PayrollError("user_not_found", 404);
}

export interface PayrollRunLine {
  userId: string | null;
  fullName: string | null;
  amount: number;
}

export type PayrollRunStatus = "accrued" | "paid" | "voided";

export interface PayrollRun {
  id: string;
  periodLabel: string;
  status: PayrollRunStatus;
  totalAmount: number;
  accrualDate: string;
  paidDate: string | null;
  voidedDate: string | null;
  createdByName: string | null;
  lines: PayrollRunLine[];
}

interface RunRow extends Record<string, unknown> {
  id: string;
  period_label: string;
  status: PayrollRunStatus;
  total_amount: string;
  accrual_date: string;
  paid_date: string | null;
  voided_date: string | null;
  created_by_name: string | null;
}
interface RunLineRow extends Record<string, unknown> {
  run_id: string;
  user_id: string | null;
  full_name: string | null;
  amount: string;
}

/**
 * The columns every run read returns, so the three call sites (list, accrue,
 * pay/void) can never drift on which fields a `RunRow` carries. `r` is the
 * `payroll_runs` alias, `u` the joined creator.
 */
const RUN_SELECT_COLUMNS = `r.id, r.period_label, r.status, r.total_amount::text AS total_amount,
            r.accrual_date::text AS accrual_date, r.paid_date::text AS paid_date,
            r.voided_at::text AS voided_date, u.full_name AS created_by_name`;

async function attachLines(businessId: string, runs: RunRow[]): Promise<PayrollRun[]> {
  if (runs.length === 0) return [];
  const { rows: lines } = await query<RunLineRow>(
    `SELECT rl.run_id, rl.user_id, u.full_name, rl.amount::text AS amount
       FROM payroll_run_lines rl
       JOIN payroll_runs r ON r.id = rl.run_id
       LEFT JOIN users u ON u.id = rl.user_id
      WHERE r.business_id = $1 AND rl.run_id = ANY($2::uuid[])
      ORDER BY u.full_name`,
    [businessId, runs.map((r) => r.id)],
  );
  const linesByRun = new Map<string, PayrollRunLine[]>();
  for (const l of lines) {
    const list = linesByRun.get(l.run_id) ?? [];
    list.push({ userId: l.user_id, fullName: l.full_name, amount: Number(l.amount) });
    linesByRun.set(l.run_id, list);
  }
  return runs.map((r) => ({
    id: r.id,
    periodLabel: r.period_label,
    status: r.status,
    totalAmount: Number(r.total_amount),
    accrualDate: r.accrual_date,
    paidDate: r.paid_date,
    voidedDate: r.voided_date,
    createdByName: r.created_by_name,
    lines: linesByRun.get(r.id) ?? [],
  }));
}

export async function listPayrollRuns(businessId: string): Promise<PayrollRun[]> {
  const { rows } = await query<RunRow>(
    `SELECT ${RUN_SELECT_COLUMNS}
       FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.business_id = $1
      ORDER BY r.accrual_date DESC, r.created_at DESC`,
    [businessId],
  );
  return attachLines(businessId, rows);
}

/** Re-read one run by id, with its creator name and lines attached. Shared by every mutation's return. */
async function getRun(businessId: string, runId: string): Promise<PayrollRun> {
  const { rows } = await query<RunRow>(
    `SELECT ${RUN_SELECT_COLUMNS}
       FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.id = $1 AND r.business_id = $2`,
    [runId, businessId],
  );
  const [run] = await attachLines(businessId, rows);
  return run;
}

export async function accruePayroll(params: {
  businessId: string;
  locationId: string | null;
  periodLabel: string;
  accrualDate?: string | null;
  createdBy: string | null;
}): Promise<PayrollRun> {
  const periodLabel = params.periodLabel.trim();
  if (!periodLabel) throw new PayrollError("period_label_required");
  // A period label is a heading somebody reads in the run list and in the
  // journal memo; an unbounded one is a 100 kB row and an unreadable list.
  if (periodLabel.length > PERIOD_LABEL_MAX) throw new PayrollError("period_label_too_long");

  // Normalise the date once, up front: the run row and its journal entry must
  // share the same value. Passing the raw `accrualDate` to the entry while the
  // row got the trimmed one desynced the two, and an empty-string date reached
  // the entry's `COALESCE($3::date, CURRENT_DATE)` as a cast error rather than
  // "today". A malformed one («banana», `2026-02-31`) used to reach that same
  // cast and surface as a 500 — it is a 400 with its own code now.
  const normalizedAccrual = normalizeOptionalIsoDate(params.accrualDate);
  if (!normalizedAccrual.ok) throw new PayrollError("invalid_accrual_date");
  const accrualDate = normalizedAccrual.value;

  const client = await getPool().connect();
  let runId = "";
  try {
    await client.query("BEGIN");

    const accounts = await accountIdsByCode(client, params.businessId, [
      WELL_KNOWN_CODES.salariesExpense,
      WELL_KNOWN_CODES.salariesPayable,
    ]);

    const { rows: staff } = await client.query<{ id: string; monthly_wage: string }>(
      `SELECT id, monthly_wage::text AS monthly_wage FROM users
        WHERE business_id = $1 AND is_active AND monthly_wage IS NOT NULL AND monthly_wage > 0`,
      [params.businessId],
    );
    if (staff.length === 0) throw new PayrollError("no_wages_set");

    const total = staff.reduce((sum, s) => sum + Number(s.monthly_wage), 0);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO payroll_runs (business_id, location_id, period_label, total_amount, accrual_date, created_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6) RETURNING id`,
      [params.businessId, params.locationId, periodLabel, total, accrualDate, params.createdBy],
    );
    runId = rows[0].id;

    for (const s of staff) {
      await client.query(`INSERT INTO payroll_run_lines (run_id, user_id, amount) VALUES ($1, $2, $3)`, [
        runId,
        s.id,
        s.monthly_wage,
      ]);
    }

    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: accrualDate,
      memo: `تعهد حقوق و دستمزد — ${periodLabel}`,
      sourceType: "payroll_accrual",
      sourceId: runId,
      createdBy: params.createdBy,
      lines: [
        { accountId: accounts.get(WELL_KNOWN_CODES.salariesExpense)!, debit: total, credit: 0 },
        { accountId: accounts.get(WELL_KNOWN_CODES.salariesPayable)!, debit: 0, credit: total },
      ],
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return getRun(params.businessId, runId);
}

export async function payPayroll(params: {
  businessId: string;
  locationId: string | null;
  runId: string;
  method: "cash" | "bank";
  paidDate?: string | null;
  actorId: string | null;
}): Promise<PayrollRun> {
  if (!isUuid(params.runId)) throw new PayrollError("run_not_found", 404);

  // Same date-desync fix as accruePayroll: the payment entry and the run's
  // paid_date must share one normalised value, and a malformed date is a 400
  // here rather than a `date` cast error surfacing as a 500.
  const normalizedPaid = normalizeOptionalIsoDate(params.paidDate);
  if (!normalizedPaid.ok) throw new PayrollError("invalid_paid_date");
  const paidDate = normalizedPaid.value;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    /*
     * Read the run *inside* the transaction and lock the row.
     *
     * The status check used to run on an unlocked read before the transaction
     * opened, so two concurrent «ثبت پرداخت حقوق» clicks (a double-click, or
     * the same run open in two tabs) both saw `accrued` and both posted a
     * payment entry: the wage bill left Cash twice and salariesPayable went
     * negative, with nothing in the UI to show it had happened. `FOR UPDATE`
     * makes the second one wait for the first to commit, then see `paid` and
     * be refused.
     */
    const { rows } = await client.query<{ id: string; status: string; total_amount: string; period_label: string }>(
      `SELECT id, status, total_amount::text AS total_amount, period_label
         FROM payroll_runs WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [params.runId, params.businessId],
    );
    const run = rows[0];
    if (!run) throw new PayrollError("run_not_found", 404);
    // A voided run reads as "already handled" too, but say so precisely rather
    // than reporting «قبلاً پرداخت شده» for a run that was actually cancelled.
    if (run.status === "voided") throw new PayrollError("run_voided", 409);
    if (run.status !== "accrued") throw new PayrollError("already_paid", 409);

    const accounts = await accountIdsByCode(client, params.businessId, [
      WELL_KNOWN_CODES.salariesPayable,
      params.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing,
    ]);
    const total = Number(run.total_amount);

    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: paidDate,
      memo: `پرداخت حقوق و دستمزد — ${run.period_label}`,
      sourceType: "payroll_payment",
      sourceId: run.id,
      createdBy: params.actorId,
      lines: [
        { accountId: accounts.get(WELL_KNOWN_CODES.salariesPayable)!, debit: total, credit: 0 },
        {
          accountId: accounts.get(params.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing)!,
          debit: 0,
          credit: total,
        },
      ],
    });

    await client.query(
      `UPDATE payroll_runs SET status = 'paid', paid_date = COALESCE($2, CURRENT_DATE) WHERE id = $1`,
      [run.id, paidDate],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return getRun(params.businessId, params.runId);
}

/**
 * Voids a payroll run — the reversal path this surface was missing.
 *
 * It posts the exact mirror of each of the run's still-standing journal
 * entries (the accrual, and the payment if the run was paid) through the same
 * `postExactMirrorEntry()` every other reversal in the app uses: dated today
 * rather than backdated, and refused when today's fiscal period is locked, so
 * a period that has been closed is never reopened to fix a mistake. The run's
 * own postings are located by their `(source_type, source_id)` identity, the
 * one-directional link this feature has always used instead of an entry_id
 * column.
 *
 * Idempotent by construction: `status = 'voided'` is rejected up front, and an
 * entry already reversed (its `reversed_at` set) is skipped rather than
 * mirrored twice.
 */
export async function voidPayrollRun(params: {
  businessId: string;
  locationId: string | null;
  runId: string;
  actorId: string | null;
}): Promise<PayrollRun> {
  if (!isUuid(params.runId)) throw new PayrollError("run_not_found", 404);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Locked inside the transaction, for the same reason `payPayroll` locks:
    // two concurrent «ابطال» clicks both read `accrued` on an unlocked check
    // and both mirrored the run's entries, double-reversing it.
    const { rows } = await client.query<{ id: string; status: PayrollRunStatus; period_label: string }>(
      `SELECT id, status, period_label FROM payroll_runs WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [params.runId, params.businessId],
    );
    const run = rows[0];
    if (!run) throw new PayrollError("run_not_found", 404);
    if (run.status === "voided") throw new PayrollError("already_voided", 409);

    // Every posting this run made, still standing (not already reversed), newest
    // first — the payment, then the accrual — so the credits are put back before
    // the expense is, the natural order of an undo.
    const { rows: entries } = await client.query<{ id: string; source_type: string }>(
      `SELECT id, source_type FROM journal_entries
        WHERE business_id = $1
          AND source_type IN ('payroll_accrual', 'payroll_payment')
          AND source_id = $2
          AND reversed_at IS NULL
          AND reverses_entry_id IS NULL
        ORDER BY entry_date DESC, posted_at DESC`,
      [params.businessId, params.runId],
    );

    for (const entry of entries) {
      await postExactMirrorEntry(client, {
        businessId: params.businessId,
        locationId: params.locationId,
        originalEntryId: entry.id,
        sourceType: `${entry.source_type}_void`,
        sourceId: params.runId,
        postingKind: "payroll_void",
        memo: `ابطال ${entry.source_type === "payroll_payment" ? "پرداخت" : "تعهد"} حقوق و دستمزد — ${run.period_label}`,
        createdBy: params.actorId,
      });
    }

    await client.query(
      `UPDATE payroll_runs SET status = 'voided', voided_at = now(), voided_by = $2 WHERE id = $1`,
      [params.runId, params.actorId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return getRun(params.businessId, params.runId);
}
