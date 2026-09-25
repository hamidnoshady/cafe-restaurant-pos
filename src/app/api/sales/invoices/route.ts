import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { industryProfile } from "@/lib/industry-profile";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getBusinessDayStatus } from "@/lib/business-day-service";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import {
  createRetailInvoice,
  RetailInvoiceError,
  type RetailInvoiceLineInput,
} from "@/lib/retail-invoice-service";
import type { SettlementMethod } from "@/lib/ledger";
import { enqueueHolooSaleForOrder } from "@/lib/integrations/holoo/outbox-producer";
import { ledgerSettlementFor, type PaymentSettlement } from "@/lib/payment-methods";
import { toLatinDigits } from "@/lib/digits";

const PAYMENT_METHODS: SettlementMethod[] = ["cash", "bank", "credit"];
const INVOICE_METHODS = new Set<string>(PAYMENT_METHODS);

function normalizedInvoiceSearch(value: string): string {
  // Cashiers commonly paste the Persian invoice number from the screen. The
  // stored order number is ASCII, so normalize only the digits and leave the
  // customer's Persian name untouched.
  return toLatinDigits(value).replace(/[٬,]/g, "").trim();
}

function isSafePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * The retail industries' sale document.
 *
 * Gated on the industry's *sales model* rather than on a named industry: any
 * trade whose profile says `retail_invoice` sells this way, so adding a fifth
 * one is a profile entry rather than another branch here. F&B is refused —
 * its sale is an order ticket, and `/api/orders` is where that lives.
 */
async function requireRetailIndustry(businessId: string) {
  const industry = await getBusinessIndustry(businessId);
  if (!industry || industryProfile(industry).salesModel !== "retail_invoice") {
    return { industry: null, error: NextResponse.json({ error: "industry_mismatch" }, { status: 403 }) };
  }
  return { industry, error: null };
}

export const POST = withTenantScope(async (request: NextRequest) => {
  // Issuing a retail invoice settles it immediately (it IS the till taking
  // payment) — the same gate the /accounting/pos page itself checks before
  // it will even render `RetailInvoiceScreen`. `ordersCreate` alone used to
  // guard this, which let e.g. a waiter's role name the permission without
  // ever being able to reach the screen that calls it.
  const { session, error } = await requirePermission(PERMISSIONS.paymentsTake);
  if (error) return error;
  const { industry, error: industryError } = await requireRetailIndustry(session.businessId);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const businessDay = await getBusinessDayStatus(location.id);

  let body: {
    lines?: unknown;
    paymentMethod?: string;
    /** Named payment way selected by the cashier; optional for old clients. */
    paymentMethodId?: string | null;
    paymentReference?: string | null;
    customerId?: string | null;
    note?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return NextResponse.json({ error: "empty_invoice" }, { status: 400 });
  }
  const paymentMethod = body.paymentMethod as SettlementMethod;
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
  }
  const customerId = typeof body.customerId === "string" && body.customerId.trim() ? body.customerId.trim() : null;
  if (customerId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM parties
        WHERE id = $1 AND business_id = $2 AND roles && ARRAY['customer']::text[]`,
      [customerId, session.businessId],
    );
    if (!rows[0]) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
  }

  const paymentMethodId = typeof body.paymentMethodId === "string" && body.paymentMethodId.trim()
    ? body.paymentMethodId.trim()
    : null;
  const paymentReference = typeof body.paymentReference === "string"
    ? body.paymentReference.trim()
    : "";
  if (paymentReference.length > 120) {
    return NextResponse.json({ error: "payment_reference_too_long" }, { status: 400 });
  }

  // A named way is tenant-owned and its settlement class must agree with the
  // compact settlement sent to the retail posting services. Without this check
  // a caller could display one way, post another, and lose the audit trail.
  let paymentWayRequiresReference = false;
  if (paymentMethodId) {
    const { rows: paymentWays } = await query<{
      settlement: string;
      requires_reference: boolean;
      is_active: boolean;
    }>(
      `SELECT settlement::text, requires_reference, is_active
         FROM payment_methods
        WHERE id = $1 AND business_id = $2`,
      [paymentMethodId, session.businessId],
    );
    const paymentWay = paymentWays[0];
    if (!paymentWay || !paymentWay.is_active || ledgerSettlementFor(paymentWay.settlement as PaymentSettlement) !== paymentMethod) {
      return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
    }
    paymentWayRequiresReference = paymentWay.requires_reference;
  }
  if (paymentWayRequiresReference && !paymentReference) {
    return NextResponse.json({ error: "payment_reference_required" }, { status: 400 });
  }

  if (body.customerId) {
    const { rowCount } = await query(
      `SELECT 1 FROM parties
        WHERE id = $1 AND business_id = $2 AND is_active
          AND (role = 'customer' OR roles @> ARRAY['customer']::text[])`,
      [body.customerId, session.businessId],
    );
    if (rowCount !== 1) {
      return NextResponse.json({ error: "customer_not_found" }, { status: 400 });
    }
  }

  // The service validates each line against the industry; this only checks the
  // shape is a line at all, so a malformed body fails before a transaction opens.
  const lines = body.lines as RetailInvoiceLineInput[];
  if (!lines.every((line) => line && typeof line === "object" && typeof line.kind === "string")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const invoice = await createRetailInvoice(client, {
      businessId: session.businessId,
      locationId: location.id,
      industry,
      lines,
      paymentMethod,
      paymentMethodId,
      paymentReference: paymentReference || null,
      customerId,
      note: typeof body.note === "string" ? body.note : null,
      businessDate: businessDay?.businessDate,
      createdBy: session.sub,
    });
    await enqueueHolooSaleForOrder(client, session.businessId, invoice.orderId);
    await client.query("COMMIT");
    return NextResponse.json({ invoice });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof RetailInvoiceError) {
      return NextResponse.json({ error: "invoice_failed", message: err.message }, { status: 400 });
    }
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "missing_ledger_account", message: err.message }, { status: 409 });
    }
    // Every sell service raises a Persian, operator-readable Error for the
    // ordinary refusals (no stock, no cost basis, no gold price for today).
    // One transaction, so this response also guarantees nothing was committed.
    if (err instanceof Error && err.message) {
      return NextResponse.json({ error: "invoice_failed", message: err.message }, { status: 400 });
    }
    throw err;
  } finally {
    client.release();
  }
});

/**
 * This branch's retail invoices, newest first — the sales history behind
 * «مدیریت فاکتورها». Filtering and pagination stay in PostgreSQL: a busy shop
 * must not download every historical invoice just to show page one.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  // Listing/searching past invoices is a read of sales history — every role
  // that can see the orders list should see this one too, not only the
  // subset that may also create a new order.
  const { session, error } = await requirePermission(PERMISSIONS.ordersView);
  if (error) return error;
  const { error: industryError } = await requireRetailIndustry(session.businessId);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const params = request.nextUrl.searchParams;
  const rawQuery = params.get("q")?.trim() ?? "";
  const q = normalizedInvoiceSearch(rawQuery);
  const method = params.get("method") ?? ""; // cash | bank | credit | "" = all
  const installmentEligible = params.get("installmentEligible") === "true";
  if (method && !INVOICE_METHODS.has(method)) {
    return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
  }

  const requestedPage = Number(params.get("page") ?? 1);
  const requestedPageSize = Number(params.get("pageSize") ?? 20);
  const page = isSafePositiveInteger(requestedPage) ? Math.min(requestedPage, 1_000_000) : 1;
  const pageSize = isSafePositiveInteger(requestedPageSize)
    ? Math.min(requestedPageSize, 100)
    : 20;
  // Retail settlement stores the bank-shaped ways as the `card` enum value.
  // Keep the public API vocabulary stable (`bank`) for the POS and installments
  // screens, while still allowing the named payment-way join to render its name.
  const dbMethod = method === "bank" ? "card" : method;
  const offset = (page - 1) * pageSize;

  const { rows } = await query<{
    id: string;
    order_number: string;
    status: string;
    total: string;
    closed_at: string;
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
     )
     SELECT invoice_rows.*, count(*) OVER ()::text AS result_count
       FROM invoice_rows
      WHERE ($5 = false OR (status = 'completed' AND credit_total::bigint > 0 AND NOT has_installment_plan))
      ORDER BY order_number DESC
      LIMIT $6 OFFSET $7`,
    [location.id, session.businessId, q, dbMethod, installmentEligible, pageSize, offset],
  );

  const invoices = rows.map((r) => ({
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

  return NextResponse.json({
    invoices,
    count: rows[0] ? Number(rows[0].result_count) : 0,
    page,
    pageSize,
    timeZone: location.timezone,
  });
});
