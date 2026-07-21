/**
 * Conflict handling for offline-queued actions (Phase 5) — pure functions.
 *
 * Decision (see docs/phases/Phase-5-Offline-Queue-Hardware.md): order
 * creation and "add items" are pure appends, so replaying them after
 * reconnect never conflicts — the server-side idempotency key
 * (client_event_id, see sync_events / src/lib/sync-events.ts) only guards
 * against double-submission if the client retries.
 *
 * order_items.status updates are different: two devices can queue
 * conflicting bumps for the same item while both are offline (e.g. kitchen
 * marks an item "ready" on a paper backup, waiter's app also queued
 * "preparing" for the same item). Rather than "last write wins" silently
 * overwriting one device's action, replay is order-based (by when the
 * action was taken) and re-validated against the status machine that
 * already exists (order-item-status.ts): whichever transition is legal from
 * the item's *current* state applies; a replay that lands on the state the
 * item is already in is a harmless duplicate (both devices did the same
 * thing); anything else — an already-voided item, a transition that skips a
 * step because a different device's action got there first — is a conflict
 * the client surfaces for manual review instead of quietly dropping it.
 */
import { canKitchenBump, canMarkServed, type OrderItemStatus } from "./order-item-status";
import type { Role } from "./auth";

export type StatusReplayOutcome = "apply" | "duplicate" | "conflict";

/**
 * Decide what to do with a queued `order_items.status` update once it's
 * finally replayed against the server, given the item's *current* status
 * (which may have moved on since the action was queued).
 */
export function classifyStatusReplay(
  current: OrderItemStatus,
  requested: OrderItemStatus,
  actorRole: Role,
): StatusReplayOutcome {
  if (current === requested) return "duplicate";
  const canKitchen = (actorRole === "owner" || actorRole === "manager" || actorRole === "kitchen") && canKitchenBump(current, requested);
  const canServe =
    (actorRole === "owner" || actorRole === "manager" || actorRole === "waiter" || actorRole === "cashier") &&
    canMarkServed(current, requested);
  return canKitchen || canServe ? "apply" : "conflict";
}
