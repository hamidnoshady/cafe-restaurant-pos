/**
 * Phase 32 — waste logging, lifted out of `/api/inventory/waste`'s route
 * handler so that the coworker's executor and the route call the *same*
 * function rather than two implementations of the same posting.
 *
 * This is the rule Phase 31 set for every executor ("the same service function
 * the route handler calls — never an internal HTTP loopback, never a second
 * mutation path"); waste was the one action whose logic had never been factored
 * out of its route, so the extraction comes with the action.
 *
 * Nothing about the posting changed in the move: the inventory event, the exact
 * consumption, the domain event that debits waste expense and credits
 * inventory, and the posted_status flip are the same statements in the same
 * transaction and the same order.
 */
import { getPool, type PoolClient } from "./db";
import { consumeInventoryExact } from "./inventory-consumption-exact";
import { WELL_KNOWN_CODES } from "./coa-template";
import type { QuantityText, RialText } from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
// Side-effect import: registers "inventory.operational_posting" with the engine.
import "./fnb-posting-rules";
import { appendSyncOutboxEvent } from "./sync-outbox";
import type { Role } from "./auth-edge";

export const WASTE_REASONS = ["spoilage", "prep_error", "customer_return", "staff_meal", "other"] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];

export function isWasteReason(value: unknown): value is WasteReason {
  return typeof value === "string" && (WASTE_REASONS as readonly string[]).includes(value);
}

export interface RecordedWaste {
  inventoryEventId: string;
  /** Integer Rial as exact text — what the consumed layers actually cost. */
  postedCost: RialText;
  duplicate?: boolean;
}

export interface RecordWasteParams {
  businessId: string;
  locationId: string;
  inventoryItemId: string;
  quantity: QuantityText;
  reason: WasteReason;
  note: string | null;
  createdBy: string | null;
  /** Caller-owned domain idempotency identity (sync client_event_id). */
  idempotencyKey?: string | null;
  sync?: { actorRole: Role; clientEventId?: string };
}

/**
 * Logs shrinkage: reduces stock without touching sales figures (separate from
 * order deduction). Runs inside the caller's transaction.
 */
export async function recordWasteInTransaction(
  client: PoolClient,
  params: RecordWasteParams,
): Promise<RecordedWaste> {
  if (params.idempotencyKey) {
    const prior = await client.query<{ id: string; posted_cost: string }>(
      `SELECT ie.id,
              COALESCE((SELECT sum(sm.cost_value_rial)::text FROM stock_movements sm
                         WHERE sm.inventory_event_id=ie.id),'0') AS posted_cost
         FROM inventory_events ie
        WHERE ie.business_id=$1 AND ie.idempotency_key=$2`,
      [params.businessId, `waste:${params.idempotencyKey}`],
    );
    if (prior.rows[0]) {
      return { inventoryEventId: prior.rows[0].id, postedCost: prior.rows[0].posted_cost as RialText, duplicate: true };
    }
  }
  const { rows: events } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id,location_id,event_type,source_type,created_by,metadata,costing_version,idempotency_key)
     VALUES($1,$2,'waste','waste',$3,jsonb_build_object('reason',$4::text),2,$5) RETURNING id`,
    [params.businessId, params.locationId, params.createdBy, params.reason,
      params.idempotencyKey ? `waste:${params.idempotencyKey}` : null],
  );
  const eventId = events[0].id;
  await client.query("UPDATE inventory_events SET source_id=id WHERE id=$1", [eventId]);

  const result = await consumeInventoryExact(client, {
    locationId: params.locationId,
    businessId: params.businessId,
    inventoryItemId: params.inventoryItemId,
    quantity: params.quantity,
    type: "waste",
    sourceType: "waste",
    sourceId: eventId,
    note: params.note,
    wasteReason: params.reason,
    createdBy: params.createdBy,
    inventoryEventId: eventId,
  });

  await emitDomainEvent(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    eventType: "inventory.operational_posting",
    payload: {
      debitCode: WELL_KNOWN_CODES.wasteExpense,
      creditCode: WELL_KNOWN_CODES.inventory,
      amount: result.postedCost,
      memo: "ضایعات",
      postingKind: "waste",
      inventoryEventId: eventId,
    },
    sourceType: "waste",
    sourceId: eventId,
    createdBy: params.createdBy,
  });
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [eventId]);
  if (params.sync) await appendSyncOutboxEvent(client, {
    locationId: params.locationId,
    clientEventId: params.sync.clientEventId ?? params.idempotencyKey ?? `waste:${eventId}`,
    eventType: "inventory.waste.recorded",
    payload: {
      inventoryItemId: params.inventoryItemId, quantity: params.quantity,
      reason: params.reason, note: params.note,
    },
    actorUserId: params.createdBy,
    actorRole: params.sync.actorRole,
  });

  return { inventoryEventId: eventId, postedCost: result.postedCost, duplicate: false };
}

/** The same write, opening and owning its own transaction. */
export async function recordWaste(params: RecordWasteParams): Promise<RecordedWaste> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const recorded = await recordWasteInTransaction(client, params);
    await client.query("COMMIT");
    return recorded;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
