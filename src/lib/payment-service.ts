import type { PoolClient } from "pg";
import { deductForOrder } from "./inventory-service";
import {
  MissingLedgerAccountError,
  postExactCogsEntry,
  postExactOrderPaymentEntry,
} from "./ledger-service";
import { getOnlinePlatformsConfig } from "./online-platforms-service";
import { lockOpenOrder } from "./order-lock";
import { rialBigInt, rialText, type RialText } from "./inventory-exact";

export const PAYMENT_METHODS = [
  "cash",
  "card",
  "card_to_card",
  "online",
  "credit",
  "snappfood",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface CompleteOrderPaymentInput {
  client: PoolClient;
  businessId: string;
  locationId: string;
  orderId: string;
  method: PaymentMethod;
  reference?: string | null;
  customerId?: string | null;
  tipAmount?: number;
  receivedBy: string | null;
}

export interface CompleteOrderPaymentResult {
  amount: RialText;
  tipAmount: number;
}

/**
 * Completes one open order inside the caller's transaction. Keeping the
 * inventory event, payment row, order status, and two ledger entries together
 * is what makes a table-wide payment safe to retry or roll back.
 */
export async function completeOrderPayment(
  input: CompleteOrderPaymentInput,
): Promise<CompleteOrderPaymentResult> {
  const {
    client,
    businessId,
    locationId,
    orderId,
    method,
    reference,
    customerId = null,
    tipAmount = 0,
    receivedBy,
  } = input;
  const locked = await lockOpenOrder(client, locationId, orderId);
  if (!locked.ok) {
    throw Object.assign(new Error(locked.error), { code: locked.error, status: locked.status });
  }

  if (customerId) {
    const { rowCount } = await client.query(
      `SELECT 1 FROM parties WHERE id = $1 AND business_id = $2`,
      [customerId, businessId],
    );
    if (rowCount !== 1) {
      throw Object.assign(new Error("customer_not_found"), {
        code: "customer_not_found",
        status: 404,
      });
    }
    await client.query(`UPDATE orders SET customer_id = $1 WHERE id = $2`, [customerId, orderId]);
  }

  const { rows: eventRows } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id, location_id, event_type, source_type, source_id, created_by, idempotency_key, costing_version)
       VALUES ($1, $2, 'sale_consumption', 'order', $3, $4, 'order-payment:' || $5, 2)
       RETURNING id`,
    [businessId, locationId, orderId, receivedBy, orderId],
  );
  const inventoryEventId = eventRows[0].id;
  const amount = rialText(locked.order.total);

  if (rialBigInt(amount) > 0n) {
    await client.query(
      `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [locationId, orderId, method, amount, reference?.trim() || null, receivedBy],
    );
  }

  const { rowCount: completed } = await client.query(
    `UPDATE orders SET status = 'completed', closed_by = $2, closed_at = now(), tip_amount = $3
      WHERE id = $1 AND status = 'open'
      RETURNING id`,
    [orderId, receivedBy, tipAmount],
  );
  if (completed !== 1) {
    throw Object.assign(new Error("order_not_open"), { code: "order_not_open", status: 409 });
  }

  const { totalCost } = await deductForOrder(
    client,
    businessId,
    locationId,
    orderId,
    receivedBy,
    inventoryEventId,
  );

  let platformCommission = "0" as RialText;
  if (method === "snappfood") {
    const { snappfood } = await getOnlinePlatformsConfig(businessId);
    if (snappfood) {
      const commissionRial = BigInt(
        Math.round(Number(rialBigInt(amount)) * (snappfood.commissionPercent / 100)),
      );
      platformCommission = rialText(commissionRial.toString());
    }
  }

  await postExactOrderPaymentEntry(client, {
    businessId,
    locationId,
    orderId,
    createdBy: receivedBy,
    method,
    amount,
    tax: rialText(locked.order.tax),
    inventoryEventId,
    orderChannel: locked.order.type,
    tip: rialText(String(tipAmount)),
    platformCommission,
  });
  await postExactCogsEntry(client, {
    businessId,
    locationId,
    orderId,
    createdBy: receivedBy,
    totalCost,
    inventoryEventId,
  });
  await client.query(`UPDATE inventory_events SET posting_status = 'posted' WHERE id = $1`, [inventoryEventId]);

  return { amount, tipAmount };
}

export function paymentErrorDetails(error: unknown): { error: string; status: number } | null {
  if (error instanceof MissingLedgerAccountError) {
    return { error: "ledger_account_missing", status: 409 };
  }
  const code = (error as { code?: string; status?: number })?.code;
  const status = (error as { status?: number })?.status;
  return code && status ? { error: code, status } : null;
}
