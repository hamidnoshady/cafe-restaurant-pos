/**
 * Delivery — pure logic (Phase 11). The lifecycle of a delivery order and
 * its display labels, kept framework-/DB-free so it's what the unit tests
 * cover (delivery-service.ts is the DB-touching side, not tested directly,
 * same split as orders.ts/order-mutations.ts).
 *
 * v1 delivery is in-house only: a delivery is dispatched to one of the
 * business's own couriers (couriers table). There is no third-party
 * platform integration and no customer-facing tracking token — status is
 * tracked staff-side on the dispatch board. The delivery fee is a flat
 * per-order amount entered at intake; it rides on the order as its
 * service_charge so it flows through payment + ledger unchanged (no new
 * accounts), see order-mutations.createOrder.
 */

export const DELIVERY_STATUSES = ["pending", "assigned", "out_for_delivery", "delivered", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * Allowed status transitions. The happy path is
 * pending → assigned → out_for_delivery → delivered; a delivery may be
 * marked failed from any non-terminal state, and an assignment can be
 * undone (assigned → pending) as long as it hasn't left the door.
 */
const TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  pending: ["assigned", "failed"],
  assigned: ["out_for_delivery", "pending", "failed"],
  out_for_delivery: ["delivered", "failed"],
  delivered: [],
  failed: [],
};

export function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly string[]).includes(value);
}

export function isTerminalDeliveryStatus(status: DeliveryStatus): boolean {
  return status === "delivered" || status === "failed";
}

/** Whether `to` is a legal next status given the current `from`. */
export function canTransitionDelivery(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses a courier must already be assigned for. Can't be out for delivery with no one carrying it. */
export function requiresCourier(status: DeliveryStatus): boolean {
  return status === "out_for_delivery" || status === "delivered";
}

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "در انتظار تخصیص",
  assigned: "تخصیص‌یافته",
  out_for_delivery: "در حال ارسال",
  delivered: "تحویل شد",
  failed: "ناموفق",
};

export function deliveryStatusLabel(status: DeliveryStatus): string {
  return DELIVERY_STATUS_LABELS[status] ?? status;
}

/**
 * Minutes a delivery took from leaving the door (dispatched_at) to the
 * customer (delivered_at). Null when either timestamp is missing or the
 * pair is out of order — the reporting view mirrors this guard in SQL.
 */
export function computeDeliveryMinutes(
  dispatchedAt: Date | string | null,
  deliveredAt: Date | string | null,
): number | null {
  if (!dispatchedAt || !deliveredAt) return null;
  const start = new Date(dispatchedAt).getTime();
  const end = new Date(deliveredAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 60000);
}
