import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Full floor-plan snapshot for the map: sections (with their assigned waiter),
 * every table with its canvas geometry + live status + open-session summary,
 * and each table's next upcoming reservation. One call powers the whole
 * /dashboard/floor screen.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ sections: [], tables: [] });
  const loc = location.id;

  const { rows: sections } = await query(
    `SELECT fs.id, fs.name, fs.color, fs.assigned_waiter_id, u.full_name AS waiter_name, fs.sort_order
       FROM floor_sections fs
       LEFT JOIN users u ON u.id = fs.assigned_waiter_id
      WHERE fs.location_id = $1
      ORDER BY fs.sort_order, fs.name`,
    [loc],
  );

  const { rows: tables } = await query(
    `SELECT dt.id, dt.name, dt.section_id, dt.capacity, dt.status,
            dt.pos_x, dt.pos_y, dt.width, dt.height, dt.shape, dt.sort_order,
            ts.id AS session_id, ts.party_size, ts.guest_name,
            ts.opened_at AS session_opened_at, ts.bill_requested_at,
            (SELECT COUNT(*) FROM orders o
               WHERE o.table_session_id = ts.id AND o.status != 'voided') AS order_count,
            (SELECT COALESCE(SUM(o.total), 0) FROM orders o
               WHERE o.table_session_id = ts.id AND o.status != 'voided') AS session_total
       FROM dining_tables dt
       LEFT JOIN table_session_tables tst
              ON tst.table_id = dt.id AND tst.released_at IS NULL
       LEFT JOIN table_sessions ts
              ON ts.id = tst.session_id AND ts.status = 'open'
      WHERE dt.location_id = $1 AND dt.is_active
      ORDER BY dt.sort_order, dt.name`,
    [loc],
  );

  // Next upcoming reservation per table (booked, within a look-ahead window).
  const { rows: reservations } = await query(
    `SELECT DISTINCT ON (table_id)
            id, table_id, customer_name, party_size, reserved_at, duration_minutes
       FROM reservations
      WHERE location_id = $1 AND table_id IS NOT NULL AND status = 'booked'
        AND reserved_at >= now() - interval '30 minutes'
        AND reserved_at <= now() + interval '12 hours'
      ORDER BY table_id, reserved_at`,
    [loc],
  );
  const nextResByTable = new Map(reservations.map((r) => [r.table_id, r]));

  const tablesOut = tables.map((t) => ({
    ...t,
    upcoming_reservation: nextResByTable.get(t.id) ?? null,
  }));

  return NextResponse.json({ sections, tables: tablesOut });
});
