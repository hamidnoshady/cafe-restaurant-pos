/**
 * IndexedDB-backed offline action queue (Phase 5), via Dexie. Browser-only
 * (like db.ts is Postgres-only) — not unit-tested, no DB/browser exception
 * that fits the pure-function convention. src/app/dashboard/offline-queue.tsx
 * is the only consumer: it enqueues here when a mutation's fetch fails
 * (LAN drop) and flushes to POST /api/sync/events on reconnect.
 */
import Dexie, { type Table } from "dexie";
import type { SyncQueueStatus } from "./sync-queue";

/**
 * "inventory.waste.recorded" (Section 5 audit extension) is the queue's
 * first non-order action type: waste logging is a single self-contained
 * write (no dependent follow-up actions like an order's add-items/status
 * flow), server-idempotent by clientEventId (waste-service.ts), and its
 * transactional domain handler already existed — see sync-event-registry.ts's
 * `offlineQueueEligible` for why this one type was opened up rather than a
 * whole other domain.
 */
export type PendingActionType =
  | "order.create"
  | "order.add_items"
  | "order_item.status"
  | "inventory.waste.recorded";

/**
 * Sync Queue System (Section 5 of the offline-first audit): the literal
 * spec's `id / action_type / table / record_id / created_at / status /
 * retry_count` fields, in this codebase's camelCase convention — see
 * sync-queue.ts for the full status-machine documentation and the pure
 * functions that drive `status`/`retryCount` transitions.
 */
export interface PendingAction {
  /** uuid; doubles as the server-side idempotency key (client_event_id) */
  id: string;
  type: PendingActionType;
  /** Domain resource this action targets, e.g. "orders" — sync-queue.ts's resolveQueueRecordRef. */
  table: string;
  /** Server-assigned id of the affected row, or null until it exists (e.g. order.create before it applies). */
  recordId: string | null;
  payload: Record<string, unknown>;
  /** ISO timestamp of when the user actually took the action */
  occurredAt: string;
  /** epoch ms; queue is flushed in this order */
  createdAt: number;
  /** Persian label for the pending-actions banner, e.g. "سفارش #۴۲" */
  description: string;
  status: SyncQueueStatus;
  retryCount: number;
  /** epoch ms of the last flush attempt for this entry, for backoff (sync-queue.ts's isQueueEntryDueForRetry). */
  lastAttemptAt: number | null;
  /** Server-reported reason code the last time this entry failed or conflicted, for the UI. */
  lastError: string | null;
}

class OfflineDb extends Dexie {
  pendingActions!: Table<PendingAction, string>;

  constructor() {
    super("pos-offline-queue");
    this.version(1).stores({
      pendingActions: "id, createdAt",
    });
    // v2 (Section 5 audit): adds the Sync Queue System's status/retry
    // bookkeeping fields. Existing rows (queued before the upgrade, still
    // pending a flush) are backfilled as fresh "pending" entries with no
    // retries yet — the safest default for a row nobody has ever seen the
    // server's answer for.
    this.version(2)
      .stores({
        pendingActions: "id, createdAt, status",
      })
      .upgrade((tx) =>
        tx
          .table("pendingActions")
          .toCollection()
          .modify((row: Partial<PendingAction> & { type: PendingActionType; payload: Record<string, unknown> }) => {
            row.status ??= "pending";
            row.retryCount ??= 0;
            row.lastAttemptAt ??= null;
            row.lastError ??= null;
            if (row.table === undefined) row.table = tableForLegacyRow(row.type);
            if (row.recordId === undefined) row.recordId = recordIdForLegacyRow(row.type, row.payload);
          }),
      );
  }
}

function tableForLegacyRow(type: PendingActionType): string {
  return type === "order_item.status" ? "order_items" : "orders";
}

function recordIdForLegacyRow(type: PendingActionType, payload: Record<string, unknown>): string | null {
  if (type === "order.add_items" && typeof payload.orderId === "string") return payload.orderId;
  if (type === "order_item.status" && typeof payload.itemId === "string") return payload.itemId;
  return null;
}

// Cached on globalThis so hot reload in dev doesn't reopen the DB repeatedly.
const globalForOfflineDb = globalThis as unknown as { offlineDb?: OfflineDb };

export function getOfflineDb(): OfflineDb {
  if (!globalForOfflineDb.offlineDb) {
    globalForOfflineDb.offlineDb = new OfflineDb();
  }
  return globalForOfflineDb.offlineDb;
}
