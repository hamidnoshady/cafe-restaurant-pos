/**
 * Item-by-item order detail for the current shift — the DB-touching half
 * (not unit-tested directly, per repo convention; the grouping rule lives in
 * shift-orders.ts and is covered by shift-orders.test.ts).
 *
 * The default shift is the most recently started one at the branch, open or
 * closed, and its window is [started_at, coalesce(ended_at, now())] — the
 * same expression listShifts' LATERAL join already uses. Deliberately *not*
 * "the newest shift with ended_at IS NULL": that would make the report go
 * blank the moment someone clocks out, and it would silently widen to
 * yesterday's window if an employee forgot to clock out. Taking the newest
 * shift either way means the report covers the shift that is running now, or
 * the one that just finished, and rolls over on its own when the next shift
 * starts — no cleanup, no stored state.
 *
 * The caller can name an earlier one instead (`shiftId`), which is why the
 * report carries the branch's recent shifts as the picker's options. The
 * chosen shift is looked up *within* that list rather than by its own query:
 * the list is already branch-scoped, so a shift id belonging to another
 * branch simply isn't found and reports nothing.
 *
 * Orders are the ones *opened* inside that window, at any status: a shift
 * review is about the work that came in during the shift, including what is
 * still open, held, or was voided. That is a wider net than the shift's cash
 * figures (shiftCashSummary counts only completed orders, by closed_at), so
 * the two are not expected to tie out — see the doc comment on `total` in
 * shift-orders.ts.
 */
import { query } from "./db";
import { groupShiftOrders, type ShiftOrder, type ShiftOrderItemInput } from "./shift-orders";

export interface ShiftOption {
  id: string;
  employeeName: string;
  startedAt: string;
  endedAt: string | null;
}

/**
 * The branch's recent shifts, newest first — the options behind every shift
 * picker (this report's, and the orders screen's since it gained one).
 *
 * A shift whose `location_id` is null is included: a shift only records a
 * branch when the session that opened it had one, so rows written before
 * openShift took a fallback branch have none, and excluding them would hide
 * exactly the shifts a single-branch business worked. Nothing branch-scoped
 * leaks by including them — every caller filters the orders themselves by
 * `location_id`, so an unattributed shift can only ever name a time window.
 */
export async function listRecentShiftOptions(
  locationId: string,
  limit = 50,
): Promise<ShiftOption[]> {
  const { rows } = await query<ShiftWindowRow>(
    `SELECT s.id, u.full_name AS employee_name, s.started_at, s.ended_at
       FROM employee_shifts s
       JOIN users u ON u.id = s.employee_id
      WHERE (s.location_id = $1 OR s.location_id IS NULL)
      ORDER BY s.started_at DESC
      LIMIT $2`,
    [locationId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    employeeName: row.employee_name,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
  }));
}

export interface ShiftOrdersReport {
  shift: ShiftOption;
  /** The branch's recent shifts, newest first — the picker's options, always including `shift`. */
  shifts: ShiftOption[];
  orders: ShiftOrder[];
}

interface ShiftWindowRow extends Record<string, unknown> {
  id: string;
  employee_name: string;
  started_at: Date;
  ended_at: Date | null;
}

interface ShiftOrderItemRow extends Record<string, unknown> {
  order_id: string;
  order_number: string; // bigint — pg returns it as a string

  type: string;
  status: string;
  table_name: string | null;
  opened_at: Date;
  order_total: string;
  item_id: string | null;
  item_name: string | null;
  quantity: number | null;
  unit_price: string | null;
  modifier_deltas: string[] | null;
  item_status: string | null;
  note: string | null;
}

/**
 * The branch's order detail for one shift, newest order first. Returns null
 * when the branch has never had a shift — the caller renders an empty state
 * rather than an arbitrary date range, since without a shift there is no
 * "until the next shift" window to report on — and also when `shiftId` names
 * a shift outside the branch's recent list, so a stale or foreign id can
 * never leak another branch's orders.
 */
export async function getShiftOrdersReport(
  locationId: string,
  shiftId?: string,
): Promise<ShiftOrdersReport | null> {
  const shifts = await listRecentShiftOptions(locationId);

  const index = shiftId ? shifts.findIndex((option) => option.id === shiftId) : 0;
  const shift = index === -1 ? undefined : shifts[index];
  if (!shift) return null;

  const { rows } = await query<ShiftOrderItemRow>(
    `SELECT o.id AS order_id, o.order_number, o.type, o.status, dt.name AS table_name,
            o.opened_at, o.total AS order_total,
            oi.id AS item_id, oi.name_snapshot AS item_name, oi.quantity, oi.unit_price,
            oi.status AS item_status, oi.note,
            coalesce(m.deltas, '{}') AS modifier_deltas
       FROM orders o
       LEFT JOIN dining_tables dt ON dt.id = o.table_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN LATERAL (
         SELECT array_agg(oim.price_delta) AS deltas
           FROM order_item_modifiers oim
          WHERE oim.order_item_id = oi.id
       ) m ON true
      WHERE o.location_id = $1
        AND o.opened_at >= $2
        AND o.opened_at <= coalesce($3::timestamptz, now())
      ORDER BY o.opened_at DESC, o.id DESC, oi.created_at`,
    [locationId, shift.startedAt, shift.endedAt],
  );

  const inputs: ShiftOrderItemInput[] = rows.map((row) => ({
    orderId: row.order_id,
    orderNumber: Number(row.order_number),
    type: row.type as ShiftOrderItemInput["type"],
    status: row.status,
    tableName: row.table_name,
    openedAt: row.opened_at.toISOString(),
    orderTotal: Number(row.order_total),
    itemId: row.item_id,
    itemName: row.item_name,
    quantity: Number(row.quantity ?? 0),
    unitPrice: Number(row.unit_price ?? 0),
    modifierDeltas: (row.modifier_deltas ?? []).map(Number),
    itemStatus: row.item_status,
    note: row.note,
  }));

  return {
    shift,
    shifts,
    orders: groupShiftOrders(inputs),
  };
}
