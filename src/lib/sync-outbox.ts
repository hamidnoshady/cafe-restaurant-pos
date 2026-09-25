/**
 * Transactional producer for site/cloud convergence.
 *
 * Call only with the PoolClient that owns the domain transaction. There is no
 * standalone-query overload on purpose: making it impossible to commit an
 * outbox row separately prevents the crash gap this module exists to close.
 */
import type { PoolClient } from "pg";
import type { Role } from "./auth";
import type { SyncEventType } from "./sync-event-registry";

export async function appendSyncOutboxEvent(
  client: PoolClient,
  input: {
    locationId: string;
    clientEventId: string;
    eventType: SyncEventType;
    payload: Record<string, unknown>;
    actorUserId: string | null;
    actorRole: Role;
    occurredAt?: string;
    schemaVersion?: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO sync_events
       (location_id,client_event_id,event_type,payload,occurred_at,applied_at,
        actor_user_id,actor_role,origin,schema_version)
     VALUES ($1,$2,$3,$4,$5,now(),$6,$7,'local',$8)
     ON CONFLICT (location_id,client_event_id) DO NOTHING`,
    [
      input.locationId,
      input.clientEventId,
      input.eventType,
      JSON.stringify(input.payload),
      input.occurredAt ?? new Date().toISOString(),
      input.actorUserId,
      input.actorRole,
      input.schemaVersion ?? 1,
    ],
  );
}
