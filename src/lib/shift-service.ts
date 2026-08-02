/**
 * Phase 20 Wave 5 — shift tracking: the DB-touching half (not unit-tested
 * directly, per repo convention — see employee-service.ts's header for why;
 * the pure rules it uses live in shift.ts and are covered by shift.test.ts).
 *
 * A shift's location_id/device_id are copied from the employee_sessions row
 * open at the moment it starts, not re-resolved from a device token — see
 * migration 0045's header for why that's the right source. Cash sales for a
 * shift are read back on demand from orders/payments by (closed_by, time
 * window), the same join v_shift_reconciliation (Phase 8) already does per
 * business-day — no new column on orders, no change to order-service.ts.
 */
import { getPool, query } from "./db";
import { reconcileCash } from "./shift";

export class ShiftError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

async function auditShift(
  businessId: string,
  actorId: string | null,
  action: string,
  shiftId: string,
  payload?: unknown,
): Promise<void> {
  await getPool().query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'shift', $4, $5)`,
    [businessId, actorId, action, shiftId, JSON.stringify(payload ?? null)],
  );
}

export interface ShiftCashSummary {
  orderCount: number;
  grossTotal: number;
  cashTotal: number;
  cardTotal: number;
  onlineTotal: number;
  creditTotal: number;
}

interface CashSummaryRow extends Record<string, unknown> {
  order_count: string;
  gross_total: string;
  cash_total: string;
  card_total: string;
  online_total: string;
  credit_total: string;
}

/**
 * Every completed order this employee closed between `from` and `to`,
 * reconciled by payment method — the same shape v_shift_reconciliation
 * (Phase 8) computes per business-day, narrowed here to one shift's own
 * window instead.
 */
export async function shiftCashSummary(
  employeeId: string,
  from: Date | string,
  to: Date | string,
): Promise<ShiftCashSummary> {
  const { rows } = await query<CashSummaryRow>(
    `SELECT count(DISTINCT o.id)                                                  AS order_count,
            coalesce(sum(o.total), 0)                                             AS gross_total,
            coalesce(sum(p.amount) FILTER (WHERE p.method = 'cash'), 0)           AS cash_total,
            coalesce(sum(p.amount) FILTER (WHERE p.method IN ('card', 'card_to_card')), 0) AS card_total,
            coalesce(sum(p.amount) FILTER (WHERE p.method = 'online'), 0)         AS online_total,
            coalesce(sum(p.amount) FILTER (WHERE p.method = 'credit'), 0)         AS credit_total
       FROM orders o
       LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.closed_by = $1 AND o.status = 'completed' AND o.closed_at BETWEEN $2 AND $3`,
    [employeeId, from, to],
  );
  const row = rows[0];
  return {
    orderCount: Number(row?.order_count ?? 0),
    grossTotal: Number(row?.gross_total ?? 0),
    cashTotal: Number(row?.cash_total ?? 0),
    cardTotal: Number(row?.card_total ?? 0),
    onlineTotal: Number(row?.online_total ?? 0),
    creditTotal: Number(row?.credit_total ?? 0),
  };
}

export interface EmployeeShift {
  id: string;
  employeeId: string;
  businessId: string;
  locationId: string | null;
  sessionId: string | null;
  deviceId: string | null;
  openingFloat: number | null;
  closingFloat: number | null;
  businessDate: string;
  startedAt: string;
  endedAt: string | null;
  closedBy: string | null;
}

interface ShiftRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  business_id: string;
  location_id: string | null;
  session_id: string | null;
  device_id: string | null;
  opening_float: string | null;
  closing_float: string | null;
  business_date: Date;
  started_at: Date;
  ended_at: Date | null;
  closed_by: string | null;
}

function toShift(row: ShiftRow): EmployeeShift {
  return {
    id: row.id,
    employeeId: row.employee_id,
    businessId: row.business_id,
    locationId: row.location_id,
    sessionId: row.session_id,
    deviceId: row.device_id,
    openingFloat: row.opening_float !== null ? Number(row.opening_float) : null,
    closingFloat: row.closing_float !== null ? Number(row.closing_float) : null,
    businessDate: row.business_date.toISOString().slice(0, 10),
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    closedBy: row.closed_by,
  };
}

const SHIFT_COLUMNS =
  "id, employee_id, business_id, location_id, session_id, device_id, opening_float, closing_float, business_date, started_at, ended_at, closed_by";

/**
 * Opens a new shift for `employeeId`, copying location/device from the
 * session that's opening it (`sessionId` — the caller's own
 * `session.employeeSessionId`) so a shift never needs its own device-token
 * resolution. `businessDate` is bucketed by that location's timezone the
 * same way every reporting view already buckets a business day (Phase 8) —
 * computed once at open time and stored, not recomputed later, so a shift
 * that runs past local midnight stays on the day it started.
 */
export async function openShift(
  employeeId: string,
  businessId: string,
  sessionId: string | null,
  openingFloat: number | null = null,
): Promise<EmployeeShift> {
  try {
    const { rows } = await query<ShiftRow>(
      `INSERT INTO employee_shifts
         (employee_id, business_id, location_id, session_id, device_id, opening_float, business_date)
       SELECT $1, $2, s.location_id, s.id, s.device_id, $4,
              (now() AT TIME ZONE coalesce(l.timezone, 'UTC'))::date
         FROM employee_sessions s
         LEFT JOIN locations l ON l.id = s.location_id
        WHERE s.id = $3 AND s.business_id = $2
       RETURNING ${SHIFT_COLUMNS}`,
      [employeeId, businessId, sessionId, openingFloat],
    );
    if (!rows[0]) throw new ShiftError("session_required", 400);
    const shift = toShift(rows[0]);
    await auditShift(businessId, employeeId, "shift.opened", shift.id, { openingFloat });
    return shift;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new ShiftError("shift_already_open", 409);
    }
    throw err;
  }
}

export async function getActiveShift(
  employeeId: string,
  businessId: string,
): Promise<EmployeeShift | null> {
  const { rows } = await query<ShiftRow>(
    `SELECT ${SHIFT_COLUMNS} FROM employee_shifts
      WHERE employee_id = $1 AND business_id = $2 AND ended_at IS NULL`,
    [employeeId, businessId],
  );
  return rows[0] ? toShift(rows[0]) : null;
}

export interface CloseShiftResult {
  shift: EmployeeShift;
  cashSummary: ShiftCashSummary;
  reconciliation: { expectedCash: number; variance: number } | null;
}

async function closeShiftRow(
  filter: { id: string } | { employeeId: string },
  businessId: string,
  actorId: string | null,
  closingFloat: number | null,
): Promise<CloseShiftResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const where = "id" in filter ? "id = $1" : "employee_id = $1";
    const param = "id" in filter ? filter.id : filter.employeeId;
    const { rows } = await client.query<ShiftRow>(
      `UPDATE employee_shifts
          SET ended_at = now(), closing_float = $3, closed_by = $4
        WHERE ${where} AND business_id = $2 AND ended_at IS NULL
        RETURNING ${SHIFT_COLUMNS}`,
      [param, businessId, closingFloat, actorId],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      throw new ShiftError("no_active_shift", 404);
    }
    await client.query("COMMIT");
    const shift = toShift(rows[0]);

    const cashSummary = await shiftCashSummary(shift.employeeId, shift.startedAt, shift.endedAt!);
    const reconciliation =
      shift.openingFloat !== null && shift.closingFloat !== null
        ? reconcileCash(shift.openingFloat, shift.closingFloat, cashSummary.cashTotal)
        : null;

    await auditShift(businessId, actorId, "shift.closed", shift.id, {
      closingFloat,
      reconciliation,
    });
    return { shift, cashSummary, reconciliation };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Self-service — ends the caller's own open shift. */
export async function closeOwnShift(
  employeeId: string,
  businessId: string,
  closingFloat: number | null = null,
): Promise<CloseShiftResult> {
  return closeShiftRow({ employeeId }, businessId, employeeId, closingFloat);
}

/** Admin force-close — an owner/manager ending a shift the employee left open (e.g. forgot to clock out). */
export async function closeShiftById(
  shiftId: string,
  businessId: string,
  actorId: string | null,
  closingFloat: number | null = null,
): Promise<CloseShiftResult> {
  return closeShiftRow({ id: shiftId }, businessId, actorId, closingFloat);
}

export interface ShiftListEntry extends EmployeeShift {
  employeeName: string;
}

interface ShiftListRow extends ShiftRow {
  employee_name: string;
}

/** Shift history for the admin review tab, most recent first. */
export async function listShifts(
  businessId: string,
  filters: { employeeId?: string; locationId?: string } = {},
): Promise<ShiftListEntry[]> {
  const params: unknown[] = [businessId];
  const conditions: string[] = ["s.business_id = $1"];
  if (filters.employeeId) {
    params.push(filters.employeeId);
    conditions.push(`s.employee_id = $${params.length}`);
  }
  if (filters.locationId) {
    params.push(filters.locationId);
    conditions.push(`s.location_id = $${params.length}`);
  }
  const { rows } = await query<ShiftListRow>(
    `SELECT s.id, s.employee_id, s.business_id, s.location_id, s.session_id, s.device_id,
            s.opening_float, s.closing_float, s.business_date, s.started_at, s.ended_at, s.closed_by,
            u.full_name AS employee_name
       FROM employee_shifts s
       JOIN users u ON u.id = s.employee_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY s.started_at DESC
      LIMIT 200`,
    params,
  );
  return rows.map((row) => ({ ...toShift(row), employeeName: row.employee_name }));
}
