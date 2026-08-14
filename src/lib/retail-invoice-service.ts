/**
 * Phase 25 Wave 3 — writing a retail sale down as a document.
 *
 * Phase 21 gave jewelry, watch and accessories each a correct *posting* path:
 * `sellWeightedItem`, `sellSerializedUnit`, `sellAccessoryUnits`. What none of
 * them produced was a sale. Each posts one item straight into the ledger from
 * an admin panel — no order row, no customer, no line items, no invoice
 * number, nothing to print, and nothing in سفارش‌ها or in any sales report. A
 * shop selling two rings and a chain to one customer had no way to say so.
 *
 * This is the missing half, and it is deliberately thin: it writes the
 * document (`orders` + `order_items`) and then calls those same three services,
 * unchanged, one per line, inside the same transaction. Every ledger posting,
 * stock decrement, serial status change, consignment settlement and item-audit
 * event is therefore exactly what Phase 21 already does and tests — this adds a
 * record of the sale, it does not add a second way to account for one.
 *
 * A retail invoice is an `orders` row rather than a parallel `invoices` table
 * for the same reason: per-location sequential numbering, payments, customer
 * linkage, the receipt pipeline, the orders list and the reporting joins all
 * already exist there. See migration 0071 for the two columns that were
 * missing.
 *
 * DB-touching, so per repo convention no direct unit test; covered by
 * integration/retail-invoice.integration.test.ts, which asserts the ledger
 * result matches the existing single-item sale tests line for line.
 */
import type { PoolClient } from "pg";
import { sellWeightedItem } from "./gold-sales-service";
import { sellSerializedUnit } from "./watch-sales-service";
import { sellAccessoryUnits } from "./accessories-service";
import { getItem } from "./items-service";
import { rialBigInt, rialText, type RialText } from "./inventory-exact";
import type { MakingChargeType } from "./gold-pricing";
import type { SettlementMethod } from "./ledger";
import type { Industry } from "./industries";

/** One line of a retail invoice, discriminated by how its industry prices things. */
export type RetailInvoiceLineInput =
  | {
      kind: "gold";
      /** A weighed piece (`items.tracking = 'weight'`). Quantity is always 1 — each piece is unique. */
      itemId: string;
      makingChargeType: MakingChargeType;
      makingChargeValue: number;
      profitPercent: number;
      vatPercent: number;
    }
  | {
      kind: "watch";
      /** A specific serialised unit (`item_serials.id`), not the model. */
      serialId: string;
      price: number;
      discount?: number;
      vatPercent: number;
      warrantyMonths?: number;
    }
  | {
      kind: "accessory";
      itemId: string;
      /** Decimal string — `item_stock.quantity` is numeric, not integer. */
      quantity: string;
      /** Omit to use the variant's standard price from `item_stock`. */
      unitPrice?: number;
      discount?: number;
      vatPercent: number;
    };

export interface CreateRetailInvoiceInput {
  businessId: string;
  locationId: string;
  industry: Industry;
  lines: RetailInvoiceLineInput[];
  paymentMethod: SettlementMethod;
  customerId?: string | null;
  note?: string | null;
  createdBy?: string | null;
}

export interface RetailInvoiceLine {
  orderItemId: string;
  itemId: string;
  name: string;
  quantity: string;
  /** Line total excluding VAT — what `order_items.unit_price` × quantity comes to. */
  net: RialText;
  vat: RialText;
  total: RialText;
  /** Gold only: the components the customer is entitled to see on the invoice. */
  metalValue?: RialText;
  makingCharge?: RialText;
  profit?: RialText;
}

export interface RetailInvoice {
  orderId: string;
  orderNumber: number;
  lines: RetailInvoiceLine[];
  subtotal: RialText;
  discount: RialText;
  tax: RialText;
  total: RialText;
}

/** Which line kinds an industry may put on an invoice — a shop sells what it stocks. */
const LINE_KINDS_BY_INDUSTRY: Record<Industry, readonly RetailInvoiceLineInput["kind"][]> = {
  food_service: [],
  jewelry: ["gold"],
  watch: ["watch"],
  accessories: ["accessory"],
};

export class RetailInvoiceError extends Error {}

function sum(values: RialText[]): RialText {
  return rialText(values.reduce((acc, v) => acc + rialBigInt(v), 0n).toString());
}

/**
 * Write and settle one retail invoice, atomically, in the caller's transaction.
 *
 * Settlement happens here rather than through `/api/orders/[id]/pay` because
 * that route's completion path is F&B's: it deducts recipe ingredients
 * (`deductForOrder`) and posts through `postExactOrderPaymentEntry`. A retail
 * line has no recipe, and its revenue/COGS split is the industry's own posting
 * rule. So the invoice is written and settled in one step — which is also what
 * a shop counter actually does, with no open-ticket stage in between.
 */
export async function createRetailInvoice(
  client: PoolClient,
  input: CreateRetailInvoiceInput,
): Promise<RetailInvoice> {
  if (input.lines.length === 0) {
    throw new RetailInvoiceError("فاکتور بدون کالا قابل ثبت نیست.");
  }
  const allowed = LINE_KINDS_BY_INDUSTRY[input.industry];
  for (const line of input.lines) {
    if (!allowed.includes(line.kind)) {
      throw new RetailInvoiceError("این نوع کالا در این کسب‌وکار قابل فروش نیست.");
    }
  }

  // Same counter every F&B order uses (order-mutations.ts), so a business's
  // invoice numbers and order numbers are one sequence per branch and can
  // never collide.
  const { rows: counter } = await client.query<{ next_number: string }>(
    `INSERT INTO order_number_counters (location_id, next_number) VALUES ($1, 2)
     ON CONFLICT (location_id) DO UPDATE SET next_number = order_number_counters.next_number + 1
     RETURNING next_number - 1 AS next_number`,
    [input.locationId],
  );
  const orderNumber = Number(counter[0].next_number);

  // Opened, filled, then completed — in that order, and not because it reads
  // nicely: `guard_order_item_mutation` (migration 0014) refuses to add a line
  // to an order that is not 'open', which is exactly the invariant that makes
  // a settled sale immutable. A retail invoice has no open-ticket *stage* the
  // user ever sees, but it still passes through the state the guard requires.
  const { rows: orderRows } = await client.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, customer_id, note, opened_by)
     VALUES ($1, $2, 'retail', 'open', $3, $4, $5)
     RETURNING id`,
    [input.locationId, orderNumber, input.customerId ?? null, input.note?.trim() || null, input.createdBy ?? null],
  );
  const orderId = orderRows[0].id;

  const lines: RetailInvoiceLine[] = [];

  for (const line of input.lines) {
    const settled = await settleLine(client, input, line);

    const { rows: itemRows } = await client.query<{ id: string }>(
      `INSERT INTO order_items
         (location_id, order_id, item_id, name_snapshot, unit_price, quantity, status,
          metal_value, making_charge, profit)
       VALUES ($1, $2, $3, $4, $5, $6, 'served', $7, $8, $9)
       RETURNING id`,
      [
        input.locationId,
        orderId,
        settled.itemId,
        settled.name,
        // `unit_price` is a bigint column and `quantity` an integer one, both
        // from the F&B model. An accessories line can be a decimal quantity of
        // a cheap variant, so the line's *net* is the authoritative number and
        // unit_price carries it at quantity 1 rather than risking a rounding
        // disagreement between the document and the ledger.
        rialBigInt(settled.net).toString(),
        1,
        settled.metalValue ?? null,
        settled.makingCharge ?? null,
        settled.profit ?? null,
      ],
    );

    lines.push({
      orderItemId: itemRows[0].id,
      itemId: settled.itemId,
      name: settled.name,
      quantity: settled.quantity,
      net: settled.net,
      vat: settled.vat,
      total: settled.total,
      metalValue: settled.metalValue,
      makingCharge: settled.makingCharge,
      profit: settled.profit,
    });
  }

  const subtotal = sum(lines.map((l) => l.net));
  const tax = sum(lines.map((l) => l.vat));
  const total = sum(lines.map((l) => l.total));

  await client.query(
    `UPDATE orders
        SET subtotal = $2, tax = $3, total = $4,
            status = 'completed', closed_by = $5, closed_at = now()
      WHERE id = $1`,
    [
      orderId,
      rialBigInt(subtotal).toString(),
      rialBigInt(tax).toString(),
      rialBigInt(total).toString(),
      input.createdBy ?? null,
    ],
  );

  // The payment row the orders list, the shift reconciliation and the
  // receipt all read. The ledger side was already posted by the per-line
  // service, so this records *how* it was collected, not a second posting.
  await client.query(
    `INSERT INTO payments (location_id, order_id, method, amount, received_by)
     VALUES ($1, $2, $3::payment_method, $4, $5)`,
    [
      input.locationId,
      orderId,
      // The ledger's SettlementMethod and the payment_method enum overlap on
      // every value the retail screen offers ('cash', 'card', 'credit');
      // 'bank' is the ledger's name for what the till calls a card payment.
      input.paymentMethod === "bank" ? "card" : input.paymentMethod,
      rialBigInt(total).toString(),
      input.createdBy ?? null,
    ],
  );

  return { orderId, orderNumber, lines, subtotal, discount: rialText("0"), tax, total };
}

interface SettledLine {
  itemId: string;
  name: string;
  quantity: string;
  net: RialText;
  vat: RialText;
  total: RialText;
  metalValue?: RialText;
  makingCharge?: RialText;
  profit?: RialText;
}

/**
 * Hand one line to its industry's existing sell service and normalise what
 * comes back. The three breakdowns name their parts differently (gold splits
 * metal/اجرت/سود, watch and accessories carry a discount) — this is the only
 * place that has to know that.
 */
async function settleLine(
  client: PoolClient,
  input: CreateRetailInvoiceInput,
  line: RetailInvoiceLineInput,
): Promise<SettledLine> {
  if (line.kind === "gold") {
    const item = await getItem(line.itemId);
    if (!item || item.locationId !== input.locationId) {
      throw new RetailInvoiceError("کالا یافت نشد.");
    }
    const { breakdown } = await sellWeightedItem(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      itemId: line.itemId,
      makingCharge: { type: line.makingChargeType, value: line.makingChargeValue },
      profitPercent: line.profitPercent,
      vatPercent: line.vatPercent,
      paymentMethod: input.paymentMethod,
      createdBy: input.createdBy ?? null,
    });
    const net = rialText(
      (
        rialBigInt(breakdown.metalValue) +
        rialBigInt(breakdown.makingCharge) +
        rialBigInt(breakdown.profit)
      ).toString(),
    );
    return {
      itemId: line.itemId,
      name: item.name,
      quantity: "1",
      net,
      vat: breakdown.vat,
      total: breakdown.total,
      metalValue: breakdown.metalValue,
      makingCharge: breakdown.makingCharge,
      profit: breakdown.profit,
    };
  }

  if (line.kind === "watch") {
    const { rows } = await client.query<{ item_id: string; serial_number: string; name: string }>(
      `SELECT s.item_id, s.serial_number, i.name
         FROM item_serials s JOIN items i ON i.id = s.item_id
        WHERE s.id = $1 AND i.location_id = $2`,
      [line.serialId, input.locationId],
    );
    if (!rows[0]) throw new RetailInvoiceError("دستگاه یافت نشد.");

    const { breakdown } = await sellSerializedUnit(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      serialId: line.serialId,
      price: line.price,
      discount: line.discount,
      vatPercent: line.vatPercent,
      paymentMethod: input.paymentMethod,
      warrantyMonths: line.warrantyMonths,
      createdBy: input.createdBy ?? null,
    });
    return {
      itemId: rows[0].item_id,
      // The serial is what identifies the unit sold; a reprint has to show it.
      name: `${rows[0].name} — ${rows[0].serial_number}`,
      quantity: "1",
      net: breakdown.net,
      vat: breakdown.vat,
      total: breakdown.total,
    };
  }

  const item = await getItem(line.itemId);
  if (!item || item.locationId !== input.locationId) {
    throw new RetailInvoiceError("کالا یافت نشد.");
  }
  const { breakdown } = await sellAccessoryUnits(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    itemId: line.itemId,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discount: line.discount,
    vatPercent: line.vatPercent,
    paymentMethod: input.paymentMethod,
    createdBy: input.createdBy ?? null,
  });
  return {
    itemId: line.itemId,
    name: item.name,
    quantity: line.quantity,
    net: breakdown.net,
    vat: breakdown.vat,
    total: breakdown.total,
  };
}
