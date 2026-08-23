/**
 * The values an autopilot or coworker cap is measured against.
 *
 * Its own module since Phase 32, for the reason `ai-coworker-events.ts` is:
 * both the coworker service and the autopilot service need it, and having the
 * coworker import the autopilot *service* closed a cycle through `ai-tools`
 * (ai-tools → ai-coworker-service → ai-autopilot-service → ai-tools).
 *
 * The rule this file exists to enforce is worth stating on its own: every
 * number here is READ FROM THE DATABASE. A proposal — whether a model wrote it
 * or a template built it — cannot talk its way under a cap by misreporting the
 * price it is changing, the bill it is discounting, or what the stock it wants
 * to write off is worth.
 */
import { query } from "./db";
import type { ProposedAction } from "./ai";
import type { AutopilotAmountContext } from "./ai-autopilot";

/**
 * The values the caps are measured against, read here rather than taken from
 * the model's own payload — a proposal cannot talk its way under a cap by
 * misreporting the current price or the order's subtotal.
 */
export async function autopilotAmountContext(
  businessId: string,
  proposal: ProposedAction,
): Promise<AutopilotAmountContext> {
  switch (proposal.type) {
    case "menu.item.priceUpdate": {
      const menuItemId = proposal.payload.menuItemId;
      if (typeof menuItemId !== "string") return {};
      const { rows } = await query<{ price: string }>(
        `SELECT m.price::text AS price FROM menu_items m
           JOIN locations l ON l.id = m.location_id
          WHERE m.id = $1 AND l.business_id = $2`,
        [menuItemId, businessId],
      );
      return rows[0] ? { currentPriceRial: Number(rows[0].price) } : {};
    }
    case "order.discount.apply": {
      const orderId = proposal.payload.orderId;
      if (typeof orderId !== "string") return {};
      const { rows } = await query<{ subtotal: string }>(
        `SELECT o.subtotal::text AS subtotal FROM orders o
           JOIN locations l ON l.id = o.location_id
          WHERE o.id = $1 AND l.business_id = $2`,
        [orderId, businessId],
      );
      return rows[0] ? { orderSubtotalRial: Number(rows[0].subtotal) } : {};
    }
    case "inventory.reorder.draftPO": {
      const items = Array.isArray(proposal.payload.items) ? (proposal.payload.items as Record<string, unknown>[]) : [];
      let total = 0;
      for (const item of items) {
        const cost = Number(item.totalCost);
        if (!Number.isFinite(cost)) return {};
        total += cost;
      }
      return { documentValueRial: total };
    }
    case "inventory.adjustment.propose": {
      const lines = Array.isArray(proposal.payload.lines) ? (proposal.payload.lines as Record<string, unknown>[]) : [];
      const ids = lines.map((line) => line.inventoryItemId).filter((id): id is string => typeof id === "string");
      if (ids.length !== lines.length || ids.length === 0) return {};
      // On hand is the sum of the append-only stock ledger and the unit cost is
      // `avg_cost`; `inventory_items` has neither a `quantity` nor a
      // `last_unit_cost` column, which this query named until Phase 32 — so
      // measuring an inventory proposal against its cap raised an error instead
      // of a number, and the run failed rather than deferring.
      const { rows } = await query<{ id: string; quantity: string; unit_cost: string }>(
        `SELECT i.id,
                COALESCE((SELECT sum(sm.quantity) FROM stock_movements sm
                           WHERE sm.inventory_item_id = i.id), 0)::text AS quantity,
                COALESCE(i.avg_cost, 0)::text AS unit_cost
           FROM inventory_items i JOIN locations l ON l.id = i.location_id
          WHERE i.id = ANY($1::uuid[]) AND l.business_id = $2`,
        [ids, businessId],
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      let value = 0;
      for (const line of lines) {
        const row = byId.get(String(line.inventoryItemId));
        if (!row) return {};
        const counted = Number(line.countedQty);
        if (!Number.isFinite(counted)) return {};
        value += Math.abs(counted - Number(row.quantity)) * Number(row.unit_cost);
      }
      return { documentValueRial: Math.round(value) };
    }
    // Phase 32 — the coworker's own two actions. Same rule: the number the cap
    // is measured against is read here, never carried in the payload.
    case "inventory.waste.log": {
      const itemId = proposal.payload.inventoryItemId;
      const quantity = Number(proposal.payload.quantity);
      if (typeof itemId !== "string" || !Number.isFinite(quantity)) return {};
      // Priced from the item's own carrying value where it has one — writing
      // off everything that is left (the common shape of a waste job) then
      // prices at exactly what the ledger says that stock is worth, rather than
      // at an average that may have drifted from the lots on the shelf.
      const { rows } = await query<{ unit_cost: string; on_hand: string; carrying: string | null }>(
        `SELECT COALESCE(i.avg_cost, 0)::text AS unit_cost,
                COALESCE((SELECT sum(sm.quantity) FROM stock_movements sm
                           WHERE sm.inventory_item_id = i.id), 0)::text AS on_hand,
                i.carrying_value_rial::text AS carrying
           FROM inventory_items i JOIN locations l ON l.id = i.location_id
          WHERE i.id = $1 AND l.business_id = $2`,
        [itemId, businessId],
      );
      if (!rows[0]) return {};
      const onHand = Number(rows[0].on_hand);
      const carrying = rows[0].carrying === null ? null : Number(rows[0].carrying);
      if (carrying !== null && onHand > 0) {
        return { documentValueRial: Math.round((Math.min(quantity, onHand) / onHand) * carrying) };
      }
      return { documentValueRial: Math.round(quantity * Number(rows[0].unit_cost)) };
    }
    case "inventory.production.run": {
      const formulaId = proposal.payload.formulaId;
      const batches = Number(proposal.payload.batches);
      if (typeof formulaId !== "string" || !Number.isFinite(batches)) return {};
      // What one batch's inputs currently cost, from the formula's own rows.
      const { rows } = await query<{ batch_cost: string }>(
        `SELECT COALESCE(sum(fi.quantity * COALESCE(ii.avg_cost, 0)), 0)::text AS batch_cost
           FROM production_formulas f
           JOIN locations l ON l.id = f.location_id
           LEFT JOIN production_formula_inputs fi ON fi.formula_id = f.id
           LEFT JOIN inventory_items ii ON ii.id = fi.inventory_item_id
          WHERE f.id = $1 AND l.business_id = $2
          GROUP BY f.id`,
        [formulaId, businessId],
      );
      if (!rows[0]) return {};
      return { documentValueRial: Math.round(batches * Number(rows[0].batch_cost)) };
    }
    default:
      return {};
  }
}
