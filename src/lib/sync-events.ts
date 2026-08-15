/**
 * Server-side inbox for offline-queued client actions (Phase 5). DB-touching
 * (not unit-tested directly, per repo convention) — pure conflict logic
 * lives in offline-sync.ts, pure order-total math in orders.ts; this module
 * only orchestrates dispatch + the idempotency dance around sync_events
 * (migration 0001, `UNIQUE (location_id, client_event_id)`).
 *
 * A device queues actions locally (src/lib/offline-db.ts) while it can't
 * reach the server and flushes them here on reconnect via
 * POST /api/sync/events, one client_event_id per queued action. Replaying
 * the same client_event_id twice (e.g. the client retried a flush that
 * actually succeeded) is a no-op: the DO NOTHING branch below reports the
 * event's original outcome instead of re-applying it.
 */
import { query } from "./db";
import { broadcast } from "./realtime";
import type { Role } from "./auth";
import type { CartItemInput } from "./order-cart";
import { addItemsToOrder, createOrder } from "./order-mutations";
import type { DiscountInput } from "./orders";
import { classifyStatusReplay } from "./offline-sync";
import type { OrderItemStatus } from "./order-item-status";

export type SyncEventType = "order.create" | "order.add_items" | "order_item.status";

export interface SyncEventInput {
  clientEventId: string;
  type: SyncEventType;
  /** when the client actually took the action, ISO — used for audit only; replay order is server-arrival order. */
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface SyncEventResult {
  clientEventId: string;
  ok: boolean;
  /** this client_event_id was already processed before; `ok` reflects its original outcome */
  duplicate?: boolean;
  /** a legitimate two-device conflict (see offline-sync.ts), not an error the client should retry */
  conflict?: boolean;
  error?: string;
  data?: unknown;
}

interface OrderCreatePayload {
  type?: "dine_in" | "takeaway" | "delivery";
  tableId?: string;
  customerId?: string;
  guestCount?: number;
  note?: string;
  discount?: { type?: "percent" | "amount"; value?: number };
  items?: CartItemInput[];
  delivery?: { address?: string; phone?: string; fee?: number; courierId?: string; note?: string };
}
interface OrderAddItemsPayload {
  orderId?: string;
  items?: CartItemInput[];
}
interface OrderItemStatusPayload {
  itemId?: string;
  status?: OrderItemStatus;
}

interface DispatchResult {
  data?: unknown;
  conflict?: boolean;
  error?: string;
}

const ORDER_MUTATION_ROLES: Role[] = ["owner", "manager", "cashier", "waiter"];

async function dispatch(
  locationId: string,
  actor: { userId: string; role: Role },
  event: SyncEventInput,
): Promise<DispatchResult> {
  if (event.type === "order.create" || event.type === "order.add_items") {
    if (!ORDER_MUTATION_ROLES.includes(actor.role)) return { error: "forbidden" };
  }

  if (event.type === "order.create") {
    const payload = event.payload as OrderCreatePayload;
    if (payload.type !== "dine_in" && payload.type !== "takeaway" && payload.type !== "delivery") {
      return { error: "invalid_order_type" };
    }
    const discountType =
      payload.discount?.type === "percent" || payload.discount?.type === "amount" ? payload.discount.type : null;
    const discount: DiscountInput = discountType
      ? { type: discountType, value: Number(payload.discount?.value ?? 0) }
      : { type: null };
    const result = await createOrder({
      locationId,
      type: payload.type,
      tableId: payload.tableId ?? null,
      customerId: payload.customerId ?? null,
      guestCount: Number.isFinite(payload.guestCount) ? Number(payload.guestCount) : null,
      note: payload.note ?? null,
      discount,
      items: payload.items ?? [],
      openedBy: actor.userId,
      delivery: payload.type === "delivery" && payload.delivery
        ? {
            address: payload.delivery.address ?? "",
            phone: payload.delivery.phone ?? null,
            fee: payload.delivery.fee ?? 0,
            courierId: payload.delivery.courierId ?? null,
            note: payload.delivery.note ?? null,
          }
        : null,
    });
    if (!result.ok) return { error: result.error };
    broadcast(locationId, { type: "order.created", orderId: result.data.id });
    return { data: result.data };
  }

  if (event.type === "order.add_items") {
    const payload = event.payload as OrderAddItemsPayload;
    if (!payload.orderId) return { error: "bad_request" };
    const result = await addItemsToOrder({ locationId, orderId: payload.orderId, items: payload.items ?? [] });
    if (!result.ok) return { error: result.error };
    broadcast(locationId, { type: "order.updated", orderId: payload.orderId });
    return { data: result.data };
  }

  if (event.type === "order_item.status") {
    const payload = event.payload as OrderItemStatusPayload;
    if (!payload.itemId || !payload.status) return { error: "bad_request" };

    const { rows } = await query<{ id: string; status: OrderItemStatus; order_id: string }>(
      `SELECT oi.id, oi.status, oi.order_id
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.id = $1 AND oi.location_id = $2 AND o.status = 'open'`,
      [payload.itemId, locationId],
    );
    const item = rows[0];
    if (!item) return { error: "item_not_found" };

    const outcome = classifyStatusReplay(item.status, payload.status, actor.role);
    if (outcome === "duplicate") return { data: { status: item.status, alreadyApplied: true } };
    if (outcome === "conflict") return { conflict: true, error: "conflict" };

    if (payload.status === "ready") {
      await query("UPDATE order_items SET status = $2, ready_at = now() WHERE id = $1", [payload.itemId, payload.status]);
    } else {
      await query("UPDATE order_items SET status = $2 WHERE id = $1", [payload.itemId, payload.status]);
    }
    broadcast(locationId, {
      type: "order.item_status",
      orderId: item.order_id,
      itemId: payload.itemId,
      status: payload.status,
    });
    return { data: { status: payload.status } };
  }

  return { error: "unknown_event_type" };
}

/**
 * Idempotently applies one queued client action, deduping on
 * (location_id, client_event_id). Call once per event, in the order the
 * client queued them — order matters for "add items to an order that was
 * itself just queued".
 */
export async function applySyncEvent(
  locationId: string,
  actor: { userId: string; role: Role },
  event: SyncEventInput,
  /**
   * Where this event came from. 'local' (default) = a client on this server;
   * 'remote' = replayed from the peer server via server-sync pull. The origin
   * is stored so the push side (server-sync.ts) only forwards locally-born
   * events and never bounces a pulled event back to its source.
   */
  origin: "local" | "remote" = "local",
): Promise<SyncEventResult> {
  const { rows: inserted } = await query<{ id: string }>(
    `INSERT INTO sync_events (location_id, client_event_id, event_type, payload, occurred_at, actor_user_id, actor_role, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (location_id, client_event_id) DO NOTHING
     RETURNING id`,
    [locationId, event.clientEventId, event.type, JSON.stringify(event.payload), event.occurredAt, actor.userId, actor.role, origin],
  );

  if (inserted.length === 0) {
    const { rows: prior } = await query<{ applied_at: string | null; error: string | null }>(
      "SELECT applied_at, error FROM sync_events WHERE location_id = $1 AND client_event_id = $2",
      [locationId, event.clientEventId],
    );
    const row = prior[0];
    return { clientEventId: event.clientEventId, ok: !row?.error, duplicate: true, error: row?.error ?? undefined };
  }

  try {
    const result = await dispatch(locationId, actor, event);
    if (result.error) {
      await query("UPDATE sync_events SET error = $2 WHERE id = $1", [inserted[0].id, result.error]);
      return { clientEventId: event.clientEventId, ok: false, conflict: result.conflict, error: result.error };
    }
    await query("UPDATE sync_events SET applied_at = now() WHERE id = $1", [inserted[0].id]);
    return { clientEventId: event.clientEventId, ok: true, data: result.data };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "apply_failed";
    await query("UPDATE sync_events SET error = $2 WHERE id = $1", [inserted[0].id, code]);
    return { clientEventId: event.clientEventId, ok: false, error: code };
  }
}
