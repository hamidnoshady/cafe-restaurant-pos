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
import { accountIdsByCode, MissingLedgerAccountError, postJournalEntry } from "./ledger-service";

export { MissingLedgerAccountError };

export class PayrollError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

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
  if (monthlyWage !== null && (!Number.isSafeInteger(monthlyWage) || monthlyWage < 0)) {
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

export interface PayrollRun {
  id: string;
  periodLabel: string;
  status: "accrued" | "paid";
  totalAmount: number;
  accrualDate: string;
  paidDate: string | null;
  createdByName: string | null;
  lines: PayrollRunLine[];
}

interface RunRow extends Record<string, unknown> {
  id: string;
  period_label: string;
  status: "accrued" | "paid";
  total_amount: string;
  accrual_date: string;
  paid_date: string | null;
  created_by_name: string | null;
}
interface RunLineRow extends Record<string, unknown> {
  run_id: string;
  user_id: string | null;
  full_name: string | null;
  amount: string;
}

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
    createdByName: r.created_by_name,
    lines: linesByRun.get(r.id) ?? [],
  }));
}

export async function listPayrollRuns(businessId: string): Promise<PayrollRun[]> {
  const { rows } = await query<RunRow>(
    `SELECT r.id, r.period_label, r.status, r.total_amount::text AS total_amount,
            r.accrual_date::text AS accrual_date, r.paid_date::text AS paid_date, u.full_name AS created_by_name
       FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.business_id = $1
      ORDER BY r.accrual_date DESC, r.created_at DESC`,
    [businessId],
  );
  return attachLines(businessId, rows);
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
      [params.businessId, params.locationId, periodLabel, total, params.accrualDate?.trim() || null, params.createdBy],
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
      entryDate: params.accrualDate ?? null,
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

  const { rows: runRows } = await query<RunRow>(
    `SELECT r.id, r.period_label, r.status, r.total_amount::text AS total_amount,
            r.accrual_date::text AS accrual_date, r.paid_date::text AS paid_date, u.full_name AS created_by_name
       FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = $1`,
    [runId],
  );
  const [run] = await attachLines(params.businessId, runRows);
  return run;
}

export async function payPayroll(params: {
  businessId: string;
  locationId: string | null;
  runId: string;
  method: "cash" | "bank";
  paidDate?: string | null;
  actorId: string | null;
}): Promise<PayrollRun> {
  const { rows } = await query<{ id: string; status: string; total_amount: string; period_label: string }>(
    `SELECT id, status, total_amount::text AS total_amount, period_label FROM payroll_runs WHERE id = $1 AND business_id = $2`,
    [params.runId, params.businessId],
  );
  const run = rows[0];
  if (!run) throw new PayrollError("run_not_found", 404);
  if (run.status !== "accrued") throw new PayrollError("already_paid", 409);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const accounts = await accountIdsByCode(client, params.businessId, [
      WELL_KNOWN_CODES.salariesPayable,
      params.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing,
    ]);
    const total = Number(run.total_amount);

    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: params.paidDate ?? null,
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
      [run.id, params.paidDate?.trim() || null],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const { rows: runRows } = await query<RunRow>(
    `SELECT r.id, r.period_label, r.status, r.total_amount::text AS total_amount,
            r.accrual_date::text AS accrual_date, r.paid_date::text AS paid_date, u.full_name AS created_by_name
       FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = $1`,
    [run.id],
  );
  const [updated] = await attachLines(params.businessId, runRows);
  return updated;
}
