import type { PoolClient } from "pg";
import type { Role } from "./auth";
import {
  assertOrderControl,
  parseOrderControlPolicy,
  type ControlledOrderAction,
} from "./order-controls";

export interface OrderActor {
  userId: string;
  role: Role;
  businessId: string;
}

export async function enforceOrderControl(
  client: PoolClient,
  input: {
    actor: OrderActor;
    orderId: string;
    action: ControlledOrderAction;
    discountPercent?: number;
  },
): Promise<void> {
  const [{ rows: settings }, { rows: kitchen }] = await Promise.all([
    client.query<{ value: unknown }>(
      `SELECT value FROM settings
        WHERE business_id = $1 AND location_id IS NULL AND key = 'orders.controls'`,
      [input.actor.businessId],
    ),
    client.query<{ kitchen_started: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM order_items
          WHERE order_id = $1
            AND status IN ('preparing', 'ready', 'served')
       ) AS kitchen_started`,
      [input.orderId],
    ),
  ]);
  assertOrderControl({
    policy: parseOrderControlPolicy(settings[0]?.value),
    actorRole: input.actor.role,
    action: input.action,
    discountPercent: input.discountPercent,
    kitchenStarted: kitchen[0]?.kitchen_started ?? false,
  });
}

export async function recordOrderAudit(
  client: PoolClient,
  input: {
    actor: OrderActor;
    locationId: string;
    action: string;
    entityType: "order" | "order_item";
    entityId: string;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (business_id, location_id, actor_id, action, entity_type, entity_id, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.actor.businessId,
      input.locationId,
      input.actor.userId,
      input.action,
      input.entityType,
      input.entityId,
      input.reason ?? null,
      JSON.stringify({
        ...input.metadata,
        actorRole: input.actor.role,
        managerAuthorizedBy:
          input.actor.role === "owner" || input.actor.role === "manager"
            ? input.actor.userId
            : null,
      }),
    ],
  );
}
