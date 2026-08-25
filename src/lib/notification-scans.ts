/**
 * Phase 35 — the one *scanned* notification producer.
 *
 * Every other producer is an event: something happened in one place in the code
 * (a shift closed, a backup failed, a coworker run needs approving) and that
 * place enqueues. `inventory.low_stock` cannot work that way. Stock leaves an
 * item through at least six paths — a sale's recipe deduction, a waste
 * write-off, a transfer out, a production consume, a stock count, a supplier
 * return — and a threshold crossing is a property of the *level* after any of
 * them, not of any one of them. Putting the check in all six would guarantee
 * that the seventh, added later, silently does not notify.
 *
 * So this scans instead, on its own slow cadence, and leans on the same
 * idempotency every other producer uses: the dedupe key is
 * `inventory.low_stock:<item>:<business date>`, so an item that sits below its
 * reorder level all week produces one notification per trading day rather than
 * one every ten minutes. `app_business_date` is what makes "day" mean the
 * branch's trading day (migration 0076), so a café working 18:00→03:00 gets one
 * alert for one night rather than two at midnight.
 *
 * It only enqueues — the tick in notifications-service.ts is still the only
 * thing that sends.
 */
import { query, withoutTenantScope, withTenant } from "./db";
import { isFeatureEnabled } from "./features";
import { recordNotification } from "./notification-events";
import { notificationDedupeKey } from "./notifications";
import { formatQuantity } from "./digits";

/**
 * Slow on purpose. A reorder level is a "order more this week" signal, not a
 * live one, and re-scanning every business's inventory every fifteen seconds to
 * discover a fact that changes twice a day would cost far more than it is worth.
 */
export const LOW_STOCK_SCAN_INTERVAL_MS = 10 * 60 * 1000;

/** At most this many items per branch per scan, so one badly-configured store room can't flood a phone. */
const MAX_ITEMS_PER_SCAN = 10;

interface LowStockRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  name: string;
  unit: string;
  on_hand: string;
  reorder_level: string;
  business_date: string;
}

/**
 * One business's items at or below their reorder level, with the branch's own
 * trading date attached so the dedupe key can be built from it.
 *
 * Mirrors the `low_stock` fact `ai-coworker-service.ts` already loads — same
 * `stock_movements` sum, same `reorder_level IS NOT NULL AND > 0` guard — so
 * the notification and the coworker's purchase draft cannot disagree about
 * which items are short.
 */
export async function scanLowStock(businessId: string): Promise<number> {
  if (!(await isFeatureEnabled(businessId, "inventory"))) return 0;

  const { rows } = await query<LowStockRow>(
    `SELECT i.id, i.location_id, i.name, i.unit,
            trim_scale(COALESCE(sm.total, 0))::text AS on_hand,
            trim_scale(i.reorder_level)::text       AS reorder_level,
            app_business_date(now(), l.timezone, l.business_day_start_minutes)::text AS business_date
       FROM inventory_items i
       JOIN locations l ON l.id = i.location_id
       LEFT JOIN (
         SELECT inventory_item_id, sum(quantity) AS total
           FROM stock_movements GROUP BY inventory_item_id
       ) sm ON sm.inventory_item_id = i.id
      WHERE l.business_id = $1 AND l.is_active AND i.is_active
        AND i.reorder_level IS NOT NULL AND i.reorder_level > 0
        AND COALESCE(sm.total, 0) <= i.reorder_level
      ORDER BY i.location_id, i.name`,
    [businessId],
  );

  const perLocation = new Map<string, number>();
  let queued = 0;
  for (const row of rows) {
    const seen = perLocation.get(row.location_id) ?? 0;
    if (seen >= MAX_ITEMS_PER_SCAN) continue;
    perLocation.set(row.location_id, seen + 1);

    await recordNotification({
      businessId,
      locationId: row.location_id,
      eventKey: "inventory.low_stock",
      severity: "important",
      title: `${row.name} به نقطهٔ سفارش رسید`,
      body: `موجودی ${formatQuantity(row.on_hand)} ${row.unit} — نقطهٔ سفارش ${formatQuantity(row.reorder_level)} ${row.unit}`,
      url: "/dashboard/inventory",
      dedupeKey: notificationDedupeKey("inventory.low_stock", row.id, row.business_date),
      payload: { inventoryItemId: row.id, onHand: row.on_hand, reorderLevel: row.reorder_level },
    });
    queued += 1;
  }
  return queued;
}

let scanInFlight = false;

/**
 * The background scan (server.ts).
 *
 * Enumerates businesses under the documented platform bypass and wraps each
 * one's scan in `withTenant`, the same shape as every other tick. A business
 * whose scan fails is logged and skipped rather than aborting the rest — one
 * tenant's misconfigured inventory must not stop another's alerts.
 */
export async function runLowStockScanTick(): Promise<number> {
  if (scanInFlight) return 0;
  scanInFlight = true;
  try {
    const businessIds = await withoutTenantScope("platform", async () => {
      const { rows } = await query<{ id: string }>(
        "SELECT id FROM businesses WHERE status = 'active' ORDER BY id",
      );
      return rows.map((row) => row.id);
    });

    let queued = 0;
    for (const businessId of businessIds) {
      try {
        queued += await withTenant(businessId, () => scanLowStock(businessId));
      } catch (error) {
        console.error(
          `low-stock scan failed for business ${businessId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return queued;
  } finally {
    scanInFlight = false;
  }
}
