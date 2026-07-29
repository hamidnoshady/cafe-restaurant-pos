import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Cashier/waiter table list. The assignment stored on a floor section is the
 * source of truth, so this endpoint never returns an unassigned section or a
 * section owned by another staff member.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("cashier", "waiter");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ sections: [], tables: [] });
  const loc = location.id;

  const { rows: sections } = await query(
    `SELECT fs.id, fs.name, fs.color, fs.assigned_waiter_id
       FROM floor_sections fs
      WHERE fs.location_id = $1 AND fs.assigned_waiter_id = $2
      ORDER BY fs.sort_order, fs.name`,
    [loc, session.sub],
  );
  const sectionIds = sections.map((section) => section.id as string);

  if (sectionIds.length === 0) {
    return NextResponse.json({ sections: [], tables: [] });
  }

  const { rows: tables } = await query(
    `SELECT dt.id, dt.name, dt.section_id, dt.capacity, dt.status,
            ts.id AS session_id, ts.party_size, ts.guest_name, ts.opened_at AS session_opened_at,
            o.id AS order_id, o.order_number
       FROM dining_tables dt
       LEFT JOIN table_session_tables tst ON tst.table_id = dt.id AND tst.released_at IS NULL
       LEFT JOIN table_sessions ts ON ts.id = tst.session_id AND ts.status = 'open'
       LEFT JOIN LATERAL (
         SELECT o.id, o.order_number FROM orders o
          WHERE o.table_session_id = ts.id AND o.status = 'open'
          ORDER BY o.opened_at DESC LIMIT 1
       ) o ON ts.id IS NOT NULL
      WHERE dt.location_id = $1 AND dt.is_active
        AND dt.section_id = ANY($2::uuid[])
      ORDER BY dt.sort_order, dt.name`,
    [loc, sectionIds],
  );

  const orderIds = tables
    .map((table) => table.order_id)
    .filter(Boolean) as string[];
  const counts = new Map<string, Record<string, number>>();
  if (orderIds.length > 0) {
    const { rows: itemCounts } = await query<{
      order_id: string;
      status: string;
      n: string;
    }>(
      `SELECT order_id, status, COUNT(*) AS n FROM order_items
        WHERE order_id = ANY($1::uuid[]) AND status != 'voided'
        GROUP BY order_id, status`,
      [orderIds],
    );
    for (const row of itemCounts) {
      if (!counts.has(row.order_id)) counts.set(row.order_id, {});
      counts.get(row.order_id)![row.status] = Number(row.n);
    }
  }

  const tablesOut = tables.map((table) => ({
    ...table,
    item_status_counts: table.order_id
      ? (counts.get(table.order_id as string) ?? {})
      : {},
  }));

  return NextResponse.json({ sections, tables: tablesOut });
});
