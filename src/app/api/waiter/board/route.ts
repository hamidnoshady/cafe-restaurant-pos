import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { getPrimaryLocation } from "@/lib/setup-state";

/**
 * The waiter app's table list: sections assigned to the logged-in waiter
 * (owner/manager see every section — the "all tables" manager overview),
 * each table's live status, open session, and its current open order with a
 * per-status item count so the waiter can see ticket progress at a glance
 * without opening the table.
 */
export async function GET() {
  const { session, error } = await requireRole("owner", "manager", "waiter");
  if (error) return error;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ sections: [], tables: [] });
  const loc = location.id;

  const scopedToWaiter = session.role === "waiter";

  const { rows: sections } = await query(
    `SELECT fs.id, fs.name, fs.color, fs.assigned_waiter_id
       FROM floor_sections fs
      WHERE fs.location_id = $1 ${scopedToWaiter ? "AND fs.assigned_waiter_id = $2" : ""}
      ORDER BY fs.sort_order, fs.name`,
    scopedToWaiter ? [loc, session.sub] : [loc],
  );
  const sectionIds = sections.map((s) => s.id as string);

  if (scopedToWaiter && sectionIds.length === 0) {
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
        ${scopedToWaiter ? "AND dt.section_id = ANY($2::uuid[])" : ""}
      ORDER BY dt.sort_order, dt.name`,
    scopedToWaiter ? [loc, sectionIds] : [loc],
  );

  const orderIds = tables.map((t) => t.order_id).filter(Boolean) as string[];
  const counts = new Map<string, Record<string, number>>();
  if (orderIds.length > 0) {
    const { rows: itemCounts } = await query<{ order_id: string; status: string; n: string }>(
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

  const tablesOut = tables.map((t) => ({
    ...t,
    item_status_counts: t.order_id ? (counts.get(t.order_id as string) ?? {}) : {},
  }));

  return NextResponse.json({ sections, tables: tablesOut });
}
