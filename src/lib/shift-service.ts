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
import { getBusinessDayStatus, type BusinessDayStatus } from "./business-day-service";
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

function toCashSummary(row: CashSummaryRow | undefined): ShiftCashSummary {
  return {
    orderCount: Number(row?.order_count ?? 0),
    grossTotal: Number(row?.gross_total ?? 0),
    cashTotal: Number(row?.cash_total ?? 0),
    cardTotal: Number(row?.card_total ?? 0),
    onlineTotal: Number(row?.online_total ?? 0),
    creditTotal: Number(row?.credit_total ?? 0),
  };
}

/**
 * The aggregate columns behind a shift's cash summary, factored out so
 * `shiftCashSummary` (a single shift's own `[from, to]` window) and
 * `listShifts`'s per-row LATERAL join (Wave 7 — every shift's window at
 * once) compute the exact same rule instead of two copies drifting apart.
 */
const CASH_SUMMARY_COLUMNS = `
  count(DISTINCT o.id)                                                  AS order_count,
  coalesce(sum(o.total), 0)                                             AS gross_total,
  coalesce(sum(p.amount) FILTER (WHERE p.method = 'cash'), 0)           AS cash_total,
  coalesce(sum(p.amount) FILTER (WHERE p.method IN ('card', 'card_to_card')), 0) AS card_total,
  coalesce(sum(p.amount) FILTER (WHERE p.method = 'online'), 0)         AS online_total,
  coalesce(sum(p.amount) FILTER (WHERE p.method = 'credit'), 0)         AS credit_total
`;

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
    `SELECT ${CASH_SUMMARY_COLUMNS}
       FROM orders o
       LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.closed_by = $1 AND o.status = 'completed' AND o.closed_at BETWEEN $2 AND $3`,
    [employeeId, from, to],
  );
  return toCashSummary(rows[0]);
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
 * resolution. `businessDate` is bucketed by `app_business_date` (migration
 * 0076), the same rule every reporting view now uses — the branch's timezone,
 * offset by its configured business-day start where it has one — computed once
 * at open time and stored, not recomputed later, so a shift that runs past
 * local midnight stays on the day it started.
 *
 * A session only carries a location when the employee has a default branch
 * assigned (users.location_id, copied at PIN/WebAuthn login) or signed in from
 * a paired device — otherwise it is null, and a shift used to be recorded with
 * no branch at all even though the request itself resolves one. The caller
 * passes that resolved branch as `fallbackLocationId` so every shift is
 * attributed to where it was actually worked; without it a branch-scoped read
 * of open shifts silently finds nothing.
 */
export async function openShift(
  employeeId: string,
  businessId: string,
  sessionId: string | null,
  openingFloat: number | null = null,
  fallbackLocationId: string | null = null,
): Promise<EmployeeShift> {
  try {
    const { rows } = await query<ShiftRow>(
      `INSERT INTO employee_shifts
         (employee_id, business_id, location_id, session_id, device_id, opening_float, business_date)
       SELECT $1, $2, coalesce(s.location_id, $5::uuid), s.id, s.device_id, $4,
              app_business_date(now(), l.timezone, l.business_day_start_minutes)
         FROM employee_sessions s
         LEFT JOIN locations l ON l.id = coalesce(s.location_id, $5::uuid)
        WHERE s.id = $3 AND s.business_id = $2
       RETURNING ${SHIFT_COLUMNS}`,
      [employeeId, businessId, sessionId, openingFloat, fallbackLocationId],
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

export interface ClosedOrdersWindow {
  /** Start of the period the orders screen lists closed orders for. */
  since: string;
  /** When the branch's running shift began, or null when nobody is clocked in. */
  shiftStartedAt: string | null;
  /** The branch's trading day as of now — null when it has no business day configured. */
  businessDay: BusinessDayStatus | null;
}

/**
 * The period the orders screen looks back over for closed orders: the current
 * business day at the branch, extended back to the start of a shift that is
 * still running if that shift began earlier.
 *
 * The first version of this keyed the window on the open shift alone, and that
 * was wrong in practice in three separate ways, each of which showed an empty
 * list on a branch that had been trading all day: a business whose staff never
 * clock in has no shift at all; an owner/manager *cannot* clock in (the shift
 * routes are cashier/waiter/kitchen only); and a cashier who clocks in at 14:00
 * would hide everything sold that morning. Anchoring on the business day fixes
 * all three, and taking the earlier of the two keeps a night shift that crossed
 * local midnight whole instead of truncating it at 00:00.
 *
 * Shifts are per employee (one open shift each), so a branch with two people
 * clocked in has two rows and the earliest wins — a colleague arriving mid-
 * service never narrows the window. A shift row whose location is null counts
 * for the branch: rows written before shifts recorded a fallback branch (see
 * openShift) have no branch of their own, and dropping them would reintroduce
 * exactly the empty list this function exists to prevent. Reads stay tenant-
 * scoped by RLS, and the orders themselves are always filtered by branch, so
 * the only thing such a row can affect is where the window starts.
 *
 * All of that is the *calendar-day* branch of this function, and it is left
 * exactly as it was. A branch that has configured a business day (روز کاری,
 * migration 0076) takes the other branch, where the trading day is authoritative
 * and the employee-shift widening is deliberately not applied: the business day
 * already keeps a night service that crosses midnight whole — which is the only
 * thing that widening was ever compensating for — and honouring an employee who
 * clocked in before the day started, or forgot to clock out last night, would
 * pull the *previous* business day's sales back into this one's list. A manual
 * close moves the start later still, so the screen goes to zero at the cash-up
 * rather than at the next day's start time.
 */
export async function branchClosedOrdersWindow(locationId: string): Promise<ClosedOrdersWindow> {
  // getBusinessDayStatus already carries where the day started (local midnight
  // for a branch with none configured, which is what this used to compute for
  // itself), so the only thing left to look up here is the open shift.
  const [{ rows }, businessDay] = await Promise.all([
    query<{ shift_started_at: Date | null }>(
      `SELECT min(s.started_at) AS shift_started_at
         FROM employee_shifts s
        WHERE s.ended_at IS NULL
          AND (s.location_id = $1 OR s.location_id IS NULL)`,
      [locationId],
    ),
    getBusinessDayStatus(locationId),
  ]);

  const shiftStartedAt = rows[0]?.shift_started_at ?? null;
  const shiftStartedAtIso = shiftStartedAt ? shiftStartedAt.toISOString() : null;

  if (businessDay?.enabled) {
    return { since: businessDay.windowStart, shiftStartedAt: shiftStartedAtIso, businessDay };
  }

  const dayStartedAt = businessDay ? new Date(businessDay.scheduledStart) : new Date();
  const since = shiftStartedAt && shiftStartedAt < dayStartedAt ? shiftStartedAt : dayStartedAt;
  return { since: since.toISOString(), shiftStartedAt: shiftStartedAtIso, businessDay: null };
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
  cashSummary: ShiftCashSummary;
  /** Only set when the shift tracked a float on both ends — see shift.ts's reconcileCash. */
  reconciliation: { expectedCash: number; variance: number } | null;
}

interface ShiftListRow extends ShiftRow, CashSummaryRow {
  employee_name: string;
}

/**
 * Shift history for the admin review tab, most recent first — each row's
 * cash summary/variance is computed in the same query via a LATERAL join
 * (Wave 7 — resolves this doc's Wave 5/6 open question 1), instead of the
 * settings tab making one `shiftCashSummary` round trip per shift.
 */
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
            u.full_name AS employee_name,
            coalesce(cs.order_count, 0) AS order_count,
            coalesce(cs.gross_total, 0) AS gross_total,
            coalesce(cs.cash_total, 0) AS cash_total,
            coalesce(cs.card_total, 0) AS card_total,
            coalesce(cs.online_total, 0) AS online_total,
            coalesce(cs.credit_total, 0) AS credit_total
       FROM employee_shifts s
       JOIN users u ON u.id = s.employee_id
       LEFT JOIN LATERAL (
         SELECT ${CASH_SUMMARY_COLUMNS}
           FROM orders o
           LEFT JOIN payments p ON p.order_id = o.id
          WHERE o.closed_by = s.employee_id AND o.status = 'completed'
            AND o.closed_at BETWEEN s.started_at AND coalesce(s.ended_at, now())
       ) cs ON true
      WHERE ${conditions.join(" AND ")}
      ORDER BY s.started_at DESC
      LIMIT 200`,
    params,
  );
  return rows.map((row) => {
    const shift = toShift(row);
    const cashSummary = toCashSummary(row);
    const reconciliation =
      shift.openingFloat !== null && shift.closingFloat !== null
        ? reconcileCash(shift.openingFloat, shift.closingFloat, cashSummary.cashTotal)
        : null;
    return { ...shift, employeeName: row.employee_name, cashSummary, reconciliation };
  });
}
