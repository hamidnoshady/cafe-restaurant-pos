/**
 * Transactional producer for site/cloud convergence.
 *
 * Call only with the PoolClient that owns the domain transaction. There is no
 * standalone-query overload on purpose: making it impossible to commit an
 * outbox row separately prevents the crash gap this module exists to close.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Role } from "./auth";
import type { SyncEventType } from "./sync-event-registry";
import { deploymentRole } from "./deployment-role";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** sync_events uses uuid keys; derive a stable UUID when the domain identity is textual. */
export function syncClientEventId(identity: string): string {
  if (UUID.test(identity)) return identity.toLowerCase();
  const hex = createHash("sha256").update(`eshobe-sync-event:${identity}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5"; // name-derived UUID semantics
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

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
  // A replay handler runs on the central process and calls the same domain
  // services as normal requests. Enforcing origin here makes bounce events
  // impossible even if a caller forgets to pass a replay flag.
  if (deploymentRole() !== "site") return;

  await client.query(
    `INSERT INTO sync_events
       (location_id,client_event_id,event_type,payload,occurred_at,applied_at,
        actor_user_id,actor_role,origin,schema_version)
     VALUES ($1,$2,$3,$4,$5,now(),$6,$7,'local',$8)
     ON CONFLICT (location_id,client_event_id) DO NOTHING`,
    [
      input.locationId,
      syncClientEventId(input.clientEventId),
      input.eventType,
      JSON.stringify(input.payload),
      input.occurredAt ?? new Date().toISOString(),
      input.actorUserId,
      input.actorRole,
      input.schemaVersion ?? 1,
    ],
  );
}
