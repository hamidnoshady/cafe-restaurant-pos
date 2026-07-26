/**
 * Phase 16 — fiscal years & periods, the DB-touching part.
 *
 * Not unit-tested directly per repo convention; the pure period-generation
 * and transition-validity logic lives in fiscal-periods.ts and is what
 * fiscal-periods.test.ts covers. The actual lock is enforced by migration
 * 0024's trigger on journal_entries, not by anything here — this file only
 * manages the fiscal_years/fiscal_periods rows themselves.
 */
import { getPool, query } from "./db";
import {
  canTransitionPeriod,
  fiscalYearSpec,
  type FiscalPeriodStatus,
} from "./fiscal-periods";

export class FiscalPeriodError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export interface FiscalYearSummary {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  closedAt: string | null;
}

export interface FiscalPeriod {
  id: string;
  fiscalYearId: string;
  label: string;
  name: string;
  startsOn: string;
  endsOn: string;
  status: FiscalPeriodStatus;
  softClosedAt: string | null;
  lockedAt: string | null;
  reopenedAt: string | null;
}

interface FiscalYearRow extends Record<string, unknown> {
  id: string;
  label: string;
  starts_on: string;
  ends_on: string;
  closed_at: string | null;
}

interface FiscalPeriodRow extends Record<string, unknown> {
  id: string;
  fiscal_year_id: string;
  label: string;
  starts_on: string;
  ends_on: string;
  status: FiscalPeriodStatus;
  soft_closed_at: string | null;
  locked_at: string | null;
  reopened_at: string | null;
}

function toYearSummary(r: FiscalYearRow): FiscalYearSummary {
  return { id: r.id, label: r.label, startsOn: r.starts_on, endsOn: r.ends_on, closedAt: r.closed_at };
}

const MONTH_NAMES = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
] as const;

function toPeriod(r: FiscalPeriodRow): FiscalPeriod {
  const monthIndex = Number(r.label.split("-")[1]) - 1;
  const year = r.label.split("-")[0];
  return {
    id: r.id,
    fiscalYearId: r.fiscal_year_id,
    label: r.label,
    name: `${MONTH_NAMES[monthIndex] ?? r.label} ${year}`,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    status: r.status,
    softClosedAt: r.soft_closed_at,
    lockedAt: r.locked_at,
    reopenedAt: r.reopened_at,
  };
}

/** Every fiscal year defined for this business, newest first. */
export async function listFiscalYears(businessId: string): Promise<FiscalYearSummary[]> {
  const { rows } = await query<FiscalYearRow>(
    `SELECT id, label, starts_on::text AS starts_on, ends_on::text AS ends_on, closed_at
       FROM fiscal_years WHERE business_id = $1 ORDER BY starts_on DESC`,
    [businessId],
  );
  return rows.map(toYearSummary);
}

/** A fiscal year's twelve periods, in calendar order. */
export async function listPeriods(businessId: string, fiscalYearId: string): Promise<FiscalPeriod[]> {
  const { rows } = await query<FiscalPeriodRow>(
    `SELECT id, fiscal_year_id, label, starts_on::text AS starts_on, ends_on::text AS ends_on,
            status::text AS status, soft_closed_at, locked_at, reopened_at
       FROM fiscal_periods WHERE business_id = $1 AND fiscal_year_id = $2 ORDER BY starts_on`,
    [businessId, fiscalYearId],
  );
  return rows.map(toPeriod);
}

/**
 * Defines a fiscal year (the Jalali year `jy`) and its twelve periods for a
 * business, atomically. Rejects a year that's already defined — there is no
 * update path for a fiscal year's boundaries once created, only for its
 * periods' statuses.
 */
export async function createFiscalYear(businessId: string, jy: number): Promise<FiscalYearSummary> {
  const spec = fiscalYearSpec(jy);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM fiscal_years WHERE business_id = $1 AND label = $2`,
      [businessId, spec.label],
    );
    if (existing[0]) {
      await client.query("ROLLBACK");
      throw new FiscalPeriodError("fiscal_year_exists", 409);
    }

    const { rows: yearRows } = await client.query<{ id: string }>(
      `INSERT INTO fiscal_years (business_id, label, starts_on, ends_on)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [businessId, spec.label, spec.startsOn, spec.endsOn],
    );
    const fiscalYearId = yearRows[0].id;

    for (const p of spec.periods) {
      await client.query(
        `INSERT INTO fiscal_periods (business_id, fiscal_year_id, label, starts_on, ends_on)
         VALUES ($1, $2, $3, $4, $5)`,
        [businessId, fiscalYearId, p.label, p.startsOn, p.endsOn],
      );
    }

    await client.query("COMMIT");
    return { id: fiscalYearId, label: spec.label, startsOn: spec.startsOn, endsOn: spec.endsOn, closedAt: null };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const STATUS_COLUMNS: Record<Exclude<FiscalPeriodStatus, "open">, { at: string; by: string }> = {
  soft_closed: { at: "soft_closed_at", by: "soft_closed_by" },
  locked: { at: "locked_at", by: "locked_by" },
};

/**
 * Moves a period to `status`, following the lifecycle open -> soft_closed ->
 * locked, reopenable from either closed state back to open (see
 * canTransitionPeriod). The caller's permission to do this at all
 * (`ledger.close_period` — owner and accountant, the resolved open question)
 * is checked by the route guard, not here.
 */
export async function setPeriodStatus(
  businessId: string,
  periodId: string,
  status: FiscalPeriodStatus,
  actorId: string,
): Promise<FiscalPeriod> {
  const { rows } = await query<{ status: FiscalPeriodStatus; fiscal_year_closed_at: string | null }>(
    `SELECT fp.status::text AS status, fy.closed_at AS fiscal_year_closed_at
       FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
      WHERE fp.id = $1 AND fp.business_id = $2`,
    [periodId, businessId],
  );
  const current = rows[0];
  if (!current) throw new FiscalPeriodError("period_not_found", 404);
  if (!canTransitionPeriod(current.status, status)) {
    throw new FiscalPeriodError("invalid_transition", 409);
  }
  // A period can't be individually reopened once its whole fiscal year has
  // been closed (closeFiscalYear in closing-service.ts) — that would leave a
  // year with a posted closing entry but an open period underneath it.
  if (status === "open" && current.fiscal_year_closed_at) {
    throw new FiscalPeriodError("fiscal_year_closed", 409);
  }

  let updateSql: string;
  let params: unknown[];
  if (status === "open") {
    updateSql = `UPDATE fiscal_periods SET status = 'open', reopened_at = now(), reopened_by = $3
                 WHERE id = $1 AND business_id = $2
                 RETURNING id, fiscal_year_id, label, starts_on::text AS starts_on, ends_on::text AS ends_on,
                           status::text AS status, soft_closed_at, locked_at, reopened_at`;
    params = [periodId, businessId, actorId];
  } else {
    const cols = STATUS_COLUMNS[status];
    updateSql = `UPDATE fiscal_periods SET status = $3, ${cols.at} = now(), ${cols.by} = $4
                 WHERE id = $1 AND business_id = $2
                 RETURNING id, fiscal_year_id, label, starts_on::text AS starts_on, ends_on::text AS ends_on,
                           status::text AS status, soft_closed_at, locked_at, reopened_at`;
    params = [periodId, businessId, status, actorId];
  }

  const { rows: updated } = await query<FiscalPeriodRow>(updateSql, params);
  return toPeriod(updated[0]);
}
