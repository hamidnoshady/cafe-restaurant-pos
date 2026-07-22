/**
 * Delivery persistence (Phase 11) — the DB-touching side of delivery.ts.
 * Not unit-tested directly (repo convention for query()/getPool() callers);
 * the transition + label logic it leans on lives in delivery.ts and is.
 *
 * The dispatch board reads listDeliveries; assignCourier / transitionDelivery
 * drive a delivery through its lifecycle, stamping dispatched_at when it
 * goes out_for_delivery and delivered_at when it lands, so the reporting
 * views can measure door-to-customer time.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import {
  canTransitionDelivery,
  isTerminalDeliveryStatus,
  requiresCourier,
  type DeliveryStatus,
} from "./delivery";

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

/** Creates the deliveries row for a freshly-inserted delivery order. Runs inside createOrder's transaction. */
export async function createDeliveryForOrder(
  client: PoolClient,
  input: {
    locationId: string;
    orderId: string;
    address: string;
    phone: string | null;
    fee: number;
    courierId: string | null;
    note: string | null;
  },
): Promise<void> {
  // If a courier is named at intake the delivery starts already assigned;
  // otherwise it lands on the board as pending for dispatch to pick up.
  const status: DeliveryStatus = input.courierId ? "assigned" : "pending";
  await client.query(
    `INSERT INTO deliveries (location_id, order_id, courier_id, status, address, phone, fee, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.locationId, input.orderId, input.courierId, status, input.address, input.phone, input.fee, input.note],
  );
}

export interface DeliveryRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  order_number: number;
  order_status: string;
  order_total: string;
  status: DeliveryStatus;
  courier_id: string | null;
  courier_name: string | null;
  address: string;
  phone: string | null;
  fee: string;
  note: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  opened_at: string;
}

/** Deliveries for the dispatch board, newest first. Active-only by default (hides delivered/failed). */
export async function listDeliveries(locationId: string, opts: { includeDone?: boolean } = {}): Promise<DeliveryRow[]> {
  const where = ["d.location_id = $1"];
  if (!opts.includeDone) where.push("d.status NOT IN ('delivered', 'failed')");
  const { rows } = await query<DeliveryRow>(
    `SELECT d.id, d.order_id, o.order_number, o.status AS order_status, o.total AS order_total,
            d.status, d.courier_id, c.name AS courier_name, d.address, d.phone, d.fee, d.note,
            d.dispatched_at, d.delivered_at, o.opened_at
       FROM deliveries d
       JOIN orders o ON o.id = d.order_id
       LEFT JOIN couriers c ON c.id = d.courier_id
      WHERE ${where.join(" AND ")}
      ORDER BY o.opened_at DESC`,
    [locationId],
  );
  return rows;
}

async function loadDelivery(locationId: string, deliveryId: string): Promise<DeliveryRow | null> {
  const { rows } = await query<DeliveryRow>(
    `SELECT d.id, d.order_id, o.order_number, o.status AS order_status, o.total AS order_total,
            d.status, d.courier_id, c.name AS courier_name, d.address, d.phone, d.fee, d.note,
            d.dispatched_at, d.delivered_at, o.opened_at
       FROM deliveries d
       JOIN orders o ON o.id = d.order_id
       LEFT JOIN couriers c ON c.id = d.courier_id
      WHERE d.location_id = $1 AND d.id = $2`,
    [locationId, deliveryId],
  );
  return rows[0] ?? null;
}

/** Assigns (or reassigns / clears) the courier on a delivery without changing its status directly. */
export async function assignCourier(
  locationId: string,
  deliveryId: string,
  courierId: string | null,
): Promise<ServiceResult<DeliveryRow>> {
  const delivery = await loadDelivery(locationId, deliveryId);
  if (!delivery) return { ok: false, error: "delivery_not_found", status: 404 };
  if (isTerminalDeliveryStatus(delivery.status)) {
    return { ok: false, error: "delivery_already_closed", status: 409 };
  }

  if (courierId) {
    const { rows } = await query<{ id: string }>(
      "SELECT id FROM couriers WHERE id = $1 AND location_id = $2 AND is_active",
      [courierId, locationId],
    );
    if (rows.length === 0) return { ok: false, error: "courier_not_found", status: 404 };
  }

  // Naming a courier on a pending delivery advances it to assigned; clearing
  // one drops it back to pending. An in-flight delivery keeps its status.
  let nextStatus: DeliveryStatus = delivery.status;
  if (delivery.status === "pending" && courierId) nextStatus = "assigned";
  else if (delivery.status === "assigned" && !courierId) nextStatus = "pending";

  await query("UPDATE deliveries SET courier_id = $1, status = $2 WHERE id = $3 AND location_id = $4", [
    courierId,
    nextStatus,
    deliveryId,
    locationId,
  ]);
  return { ok: true, data: (await loadDelivery(locationId, deliveryId))! };
}

/** Moves a delivery to a new status, enforcing the legal transition + courier requirement and stamping timestamps. */
export async function transitionDelivery(
  locationId: string,
  deliveryId: string,
  to: DeliveryStatus,
): Promise<ServiceResult<DeliveryRow>> {
  const delivery = await loadDelivery(locationId, deliveryId);
  if (!delivery) return { ok: false, error: "delivery_not_found", status: 404 };
  if (!canTransitionDelivery(delivery.status, to)) {
    return { ok: false, error: "invalid_delivery_transition", status: 409 };
  }
  if (requiresCourier(to) && !delivery.courier_id) {
    return { ok: false, error: "courier_required", status: 409 };
  }

  const sets = ["status = $1"];
  if (to === "out_for_delivery") sets.push("dispatched_at = now()");
  if (to === "delivered") sets.push("delivered_at = now()");
  // Undoing an assignment clears the (not-yet-set) dispatch stamp defensively.
  if (to === "pending") sets.push("dispatched_at = NULL");

  await query(`UPDATE deliveries SET ${sets.join(", ")} WHERE id = $2 AND location_id = $3`, [
    to,
    deliveryId,
    locationId,
  ]);
  return { ok: true, data: (await loadDelivery(locationId, deliveryId))! };
}

export interface CourierRow extends Record<string, unknown> {
  id: string;
  name: string;
  phone: string | null;
  is_active: boolean;
}

export async function listCouriers(locationId: string, opts: { includeInactive?: boolean } = {}): Promise<CourierRow[]> {
  const where = ["location_id = $1"];
  if (!opts.includeInactive) where.push("is_active");
  const { rows } = await query<CourierRow>(
    `SELECT id, name, phone, is_active FROM couriers WHERE ${where.join(" AND ")} ORDER BY name`,
    [locationId],
  );
  return rows;
}

export async function createCourier(
  locationId: string,
  input: { name: string; phone: string | null },
): Promise<ServiceResult<CourierRow>> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "name_required", status: 400 };
  const { rows } = await query<CourierRow>(
    `INSERT INTO couriers (location_id, name, phone) VALUES ($1, $2, $3)
     RETURNING id, name, phone, is_active`,
    [locationId, name, input.phone?.trim() || null],
  );
  return { ok: true, data: rows[0] };
}

export async function setCourierActive(
  locationId: string,
  courierId: string,
  isActive: boolean,
): Promise<ServiceResult<CourierRow>> {
  const { rows } = await query<CourierRow>(
    `UPDATE couriers SET is_active = $1 WHERE id = $2 AND location_id = $3
     RETURNING id, name, phone, is_active`,
    [isActive, courierId, locationId],
  );
  if (rows.length === 0) return { ok: false, error: "courier_not_found", status: 404 };
  return { ok: true, data: rows[0] };
}
