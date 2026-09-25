/**
 * The retail invoice history query — extracted out of
 * `src/app/api/sales/invoices/route.ts`'s `GET` handler so it can be
 * exercised directly against a real database (integration/retail-invoice-
 * list.integration.test.ts) without reconstructing a `NextRequest`/session.
 * The route stays responsible for auth, parameter parsing/validation and the
 * HTTP response shape; this owns only the query and the row mapping.
 */
import { query } from "../db";

export interface RetailInvoiceListRow {
  id: string;
  orderNumber: number;
  status: string;
  total: number;
  closedAt: string | null;
  customerName: string | null;
  lineCount: number;
  paymentMethod: string | null;
  paymentMethodName: string | null;
  creditTotal: number;
  hasInstallmentPlan: boolean;
}

export interface ListRetailInvoicesInput {
  businessId: string;
  locationId: string;
  /** Already normalised (see `normalizedInvoiceSearch`), "" = no filter. */
  q: string;
  /** The ledger/payment_method enum value ('card' for a bank way), "" = all. */
  method: string;
  /** "completed" | "voided" | "" = all. */
  status: string;
  /** ISO calendar date (YYYY-MM-DD), "" = no lower bound. */
  dateFrom: string;
  /** ISO calendar date (YYYY-MM-DD), "" = no upper bound. */
  dateTo: string;
  installmentEligible: boolean;
  page: number;
  pageSize: number;
}

export async function listRetailInvoices(
  input: ListRetailInvoicesInput,
): Promise<{ invoices: RetailInvoiceListRow[]; count: number }> {
  const offset = (input.page - 1) * input.pageSize;

  const { rows } = await query<{
    id: string;
    order_number: string;
    status: string;
    total: string;
    closed_at: string | null;
    customer_name: string | null;
    line_count: string;
    pay_method: string | null;
    payment_method_name: string | null;
    credit_total: string;
    has_installment_plan: boolean;
    result_count: string;
  }>(
    `WITH invoice_rows AS (
       SELECT o.id, o.order_number, o.status, o.total, o.closed_at,
              c.name AS customer_name,
              (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.id) AS line_count,
              tender.method::text AS pay_method,
              pm.name AS payment_method_name,
              COALESCE((SELECT sum(p.amount) FROM payments p
                          WHERE p.order_id = o.id AND p.method = 'credit'), 0)::text AS credit_total,
              EXISTS (SELECT 1 FROM installments ip
                        WHERE ip.business_id = $2 AND ip.invoice_order_id = o.id) AS has_installment_plan
         FROM orders o
         JOIN locations l ON l.id = o.location_id
         LEFT JOIN parties c ON c.id = o.customer_id
         LEFT JOIN LATERAL (
           SELECT p.method, p.payment_method_id
             FROM payments p
            WHERE p.order_id = o.id
            ORDER BY p.received_at, p.id
            LIMIT 1
         ) tender ON true
         LEFT JOIN payment_methods pm ON pm.id = tender.payment_method_id
        WHERE o.location_id = $1
          AND o.type = 'retail'
          AND o.status IN ('completed', 'voided')
          AND ($3 = '' OR c.name ILIKE '%' || $3 || '%' OR o.order_number::text LIKE '%' || $3 || '%')
          AND ($4 = '' OR tender.method::text = $4)
          AND ($8 = '' OR o.status::text = $8)
          -- A Jalali date range on the screen, stored and compared as plain
          -- ISO calendar dates against the branch's own business day
          -- (app_business_date — migration 0076), the same function the
          -- dashboard and reports use, so a sale rung up after midnight but
          -- before the branch's day-start still lands on the day the cashier
          -- rang it up, not the calendar day the clock read.
          AND ($9 = '' OR app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) >= $9::date)
          AND ($10 = '' OR app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) <= $10::date)
     )
     SELECT invoice_rows.*, count(*) OVER ()::text AS result_count
       FROM invoice_rows
      WHERE ($5 = false OR (status = 'completed' AND credit_total::bigint > 0 AND NOT has_installment_plan))
      ORDER BY order_number DESC
      LIMIT $6 OFFSET $7`,
    [
      input.locationId,
      input.businessId,
      input.q,
      input.method,
      input.installmentEligible,
      input.pageSize,
      offset,
      input.status,
      input.dateFrom,
      input.dateTo,
    ],
  );

  const invoices: RetailInvoiceListRow[] = rows.map((r) => ({
    id: r.id,
    orderNumber: Number(r.order_number),
    status: r.status,
    total: Number(r.total),
    closedAt: r.closed_at,
    customerName: r.customer_name,
    lineCount: Number(r.line_count),
    // The API deliberately exposes settlement vocabulary, not the underlying
    // payment enum (`card` is what a retail bank payment stores).
    paymentMethod:
      r.pay_method === "card"
        ? "bank"
        : r.pay_method === "cash" || r.pay_method === "credit"
          ? r.pay_method
          : r.pay_method,
    paymentMethodName:
      r.payment_method_name ??
      (r.pay_method === "cash"
        ? "نقدی"
        : r.pay_method === "card"
          ? "کارت‌خوان"
          : r.pay_method === "credit"
            ? "نسیه"
            : r.pay_method),
    creditTotal: Number(r.credit_total),
    hasInstallmentPlan: r.has_installment_plan,
  }));

  return { invoices, count: rows[0] ? Number(rows[0].result_count) : 0 };
}
