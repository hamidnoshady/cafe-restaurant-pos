/**
 * Sync Queue System (Phase 5 / Section 5 of the desktop offline-first audit)
 * — pure state-machine logic for the client's offline action queue, split
 * out of offline-queue.tsx the same way offline-sync.ts holds sync-events.ts's
 * pure conflict logic (browser/IndexedDB code is not unit-tested per repo
 * convention; this file has no such dependency and is).
 *
 * The literal field list the audit asked for —
 * `id / action_type / table / record_id / created_at / status / retry_count`
 * — maps onto this codebase's existing camelCase convention (see
 * clientEventId, occurredAt, createdAt elsewhere) as:
 *
 *   id          -> PendingAction.id          (uuid; also the server idempotency key)
 *   action_type -> PendingAction.type         (e.g. "order.create")
 *   table       -> PendingAction.table        (the domain resource, e.g. "orders")
 *   record_id   -> PendingAction.recordId     (null until the server assigns one,
 *                                              e.g. a not-yet-created order)
 *   created_at  -> PendingAction.createdAt
 *   status      -> PendingAction.status       (see SyncQueueStatus below)
 *   retry_count -> PendingAction.retryCount
 *
 * Status lifecycle:
 *
 *   pending --(flush attempt)--> syncing --(server applied)-------> completed (row deleted)
 *                                        \-(network/server down)--> pending   (retried, no penalty)
 *                                        \-(server rejected)-------> pending (retryCount++) or
 *                                                                     failed  (retryCount hit the cap)
 *                                        \-(legitimate 2-device
 *                                           conflict, offline-sync.ts)-> conflict (never auto-retried)
 *
 * `failed` and `conflict` are terminal until a human acts (see
 * discardQueueEntry/retryQueueEntry in offline-queue.tsx) — neither is
 * silently dropped, which is the gap this module closes: the previous queue
 * only ever had an implicit two-state model (pending, then deleted).
 */
import type { PendingActionType } from "./offline-db";

export type SyncQueueStatus = "pending" | "syncing" | "completed" | "failed" | "conflict";

export const SYNC_QUEUE_STATUS_LABELS: Record<SyncQueueStatus, string> = {
  pending: "در انتظار ارسال",
  syncing: "در حال ارسال",
  completed: "تکمیل‌شده",
  failed: "ناموفق",
  conflict: "نیازمند بررسی (تداخل)",
};

/** A queued action never auto-retries past this many failed server attempts. */
export const MAX_SYNC_RETRIES = 5;

/** Which table/record a queued action targets, for the queue's own bookkeeping (not a foreign key). */
export interface SyncQueueRecordRef {
  table: string;
  recordId: string | null;
}

/**
 * Derives the (table, recordId) pair for a queued action from its payload.
 * `order.create` has no server-assigned id yet — the record doesn't exist
 * until the action applies — so recordId is null until then.
 */
export function resolveQueueRecordRef(
  type: PendingActionType,
  payload: Record<string, unknown>,
): SyncQueueRecordRef {
  switch (type) {
    case "order.create":
      return { table: "orders", recordId: null };
    case "order.add_items":
      return { table: "orders", recordId: typeof payload.orderId === "string" ? payload.orderId : null };
    case "order_item.status":
      return { table: "order_items", recordId: typeof payload.itemId === "string" ? payload.itemId : null };
    case "inventory.waste.recorded":
      // No server-assigned id yet — like order.create, the inventory event
      // this becomes doesn't exist until the queued action applies.
      return { table: "inventory_items", recordId: typeof payload.inventoryItemId === "string" ? payload.inventoryItemId : null };
    default:
      return { table: "unknown", recordId: null };
  }
}

/**
 * Exponential backoff before a `failed` entry is retried again, so a batch of
 * rejected actions doesn't hammer the local server every poll. Same shape as
 * message-outbox-service's retryBackoffMs but tuned for a same-LAN local
 * server (seconds, not minutes) rather than an Internet SMS/email provider.
 */
export function retryBackoffMs(retryCount: number): number {
  return Math.min(5_000 * 2 ** Math.max(retryCount - 1, 0), 5 * 60_000);
}

export interface QueueEntryTiming {
  status: SyncQueueStatus;
  retryCount: number;
  lastAttemptAt?: number | null;
}

/**
 * Whether a queue entry should be included in the next flush attempt.
 * `conflict` and `completed` are excluded — a conflict needs a human
 * decision (see retryQueueEntry) and a completed row is already gone.
 * `syncing` is included: if a browser tab closed mid-flush, that status
 * would otherwise persist forever with no in-flight request to finish it.
 */
export function isQueueEntryDueForRetry(entry: QueueEntryTiming, now: number): boolean {
  if (entry.status === "conflict" || entry.status === "completed") return false;
  if (entry.status === "pending" || entry.status === "syncing") return true;
  // status === "failed"
  const last = entry.lastAttemptAt ?? 0;
  return now - last >= retryBackoffMs(entry.retryCount);
}

export interface FlushOutcomeInput {
  ok: boolean;
  conflict?: boolean;
}

export interface FlushOutcome {
  /** Never "syncing": that is only the in-flight state, not an outcome. */
  status: Exclude<SyncQueueStatus, "syncing">;
  retryCount: number;
}

/**
 * Classifies what happened to one queued action after a flush attempt into
 * its next status + retry count.
 *
 * `result` is `undefined` when the batch response didn't mention this
 * clientEventId at all — a malformed/partial server response, not this
 * action's fault — so it goes back to `pending` untouched, exactly like a
 * whole-batch network failure would; only an explicit non-conflict rejection
 * (`{ ok: false }` present in the response) counts against the retry cap.
 */
export function classifyFlushOutcome(
  result: FlushOutcomeInput | undefined,
  previousRetryCount: number,
): FlushOutcome {
  if (!result) {
    return { status: "pending", retryCount: previousRetryCount };
  }
  if (result.ok && !result.conflict) {
    return { status: "completed", retryCount: previousRetryCount };
  }
  if (result.conflict) {
    return { status: "conflict", retryCount: previousRetryCount };
  }
  const retryCount = previousRetryCount + 1;
  return retryCount >= MAX_SYNC_RETRIES ? { status: "failed", retryCount } : { status: "pending", retryCount };
}
