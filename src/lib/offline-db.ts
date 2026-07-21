/**
 * IndexedDB-backed offline action queue (Phase 5), via Dexie. Browser-only
 * (like db.ts is Postgres-only) — not unit-tested, no DB/browser exception
 * that fits the pure-function convention. src/app/dashboard/offline-queue.tsx
 * is the only consumer: it enqueues here when a mutation's fetch fails
 * (LAN drop) and flushes to POST /api/sync/events on reconnect.
 */
import Dexie, { type Table } from "dexie";

export type PendingActionType = "order.create" | "order.add_items" | "order_item.status";

export interface PendingAction {
  /** uuid; doubles as the server-side idempotency key (client_event_id) */
  id: string;
  type: PendingActionType;
  payload: Record<string, unknown>;
  /** ISO timestamp of when the user actually took the action */
  occurredAt: string;
  /** epoch ms; queue is flushed in this order */
  createdAt: number;
  /** Persian label for the pending-actions banner, e.g. "سفارش #۴۲" */
  description: string;
}

class OfflineDb extends Dexie {
  pendingActions!: Table<PendingAction, string>;

  constructor() {
    super("pos-offline-queue");
    this.version(1).stores({
      pendingActions: "id, createdAt",
    });
  }
}

// Cached on globalThis so hot reload in dev doesn't reopen the DB repeatedly.
const globalForOfflineDb = globalThis as unknown as { offlineDb?: OfflineDb };

export function getOfflineDb(): OfflineDb {
  if (!globalForOfflineDb.offlineDb) {
    globalForOfflineDb.offlineDb = new OfflineDb();
  }
  return globalForOfflineDb.offlineDb;
}
