import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { rankKitchenQueue, type KitchenQueueEntry } from "@/lib/kitchen-priority";

/**
 * Live kitchen ticket queue: every non-voided, non-served order item across
 * open orders, oldest first. The client groups rows into tickets by
 * `table_session_id` (dine-in — one ticket per table, spanning rounds) or by
 * `order_id` (takeaway/delivery — no session to group by).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "kitchen");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ items: [] });

  const { rows: rawItems } = await query<KitchenQueueEntry & Record<string, unknown>>(
    `SELECT oi.id, oi.order_id, oi.name_snapshot, oi.quantity, oi.status, oi.note,
            oi.sent_to_kitchen_at, oi.ready_at,
            o.type AS order_type, o.order_number, o.table_session_id, o.table_id,
            dt.name AS table_name
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN dining_tables dt ON dt.id = o.table_id
      WHERE oi.location_id = $1 AND o.status = 'open'
        AND oi.status IN ('sent', 'preparing', 'ready')
      ORDER BY oi.sent_to_kitchen_at ASC NULLS LAST`,
    [location.id],
  );

  // No provider call: Wave 3 ranks the same queue deterministically from the
  // recorded status and kitchen-send time. The shared helper is also used by the KDS.
  const items = rankKitchenQueue(rawItems);

  const { rows: modifiers } = await query(
    `SELECT oim.order_item_id, oim.name_snapshot
       FROM order_item_modifiers oim
       JOIN order_items oi ON oi.id = oim.order_item_id
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.location_id = $1 AND o.status = 'open'
        AND oi.status IN ('sent', 'preparing', 'ready')`,
    [location.id],
  );

  return NextResponse.json({ items, modifiers });
});
