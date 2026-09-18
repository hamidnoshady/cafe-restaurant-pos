import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { industryProfile } from "@/lib/industry-profile";
import { resolveActiveLocation } from "@/lib/setup-state";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import {
  createRetailInvoice,
  RetailInvoiceError,
  type RetailInvoiceLineInput,
} from "@/lib/retail-invoice-service";
import type { SettlementMethod } from "@/lib/ledger";
import { enqueueHolooSaleForOrder } from "@/lib/integrations/holoo/outbox-producer";

const PAYMENT_METHODS: SettlementMethod[] = ["cash", "bank", "credit"];

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
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const { industry, error: industryError } = await requireRetailIndustry(session.businessId);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: {
    lines?: unknown;
    paymentMethod?: string;
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
      customerId: typeof body.customerId === "string" && body.customerId ? body.customerId : null,
      note: typeof body.note === "string" ? body.note : null,
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
 * This branch's retail invoices, newest first — the sales history the shop
 * never had, and the data behind the «مدیریت فاکتورها» view: searchable by
 * customer or invoice number, filterable by settlement method, paginated.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "accountant");
  if (error) return error;
  const { error: industryError } = await requireRetailIndustry(session.businessId);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const params = request.nextUrl.searchParams;
  const q = params.get("q")?.trim() ?? "";
  const method = params.get("method") ?? ""; // cash | bank | credit | "" = all
  const installmentEligible = params.get("installmentEligible") === "true";
  const page = Math.max(Number(params.get("page") ?? 1) || 1, 1);
  const pageSize = Math.min(Math.max(Number(params.get("pageSize") ?? 20) || 20, 5), 100);

  const { rows } = await query<{
    id: string;
    order_number: string;
    total: string;
    closed_at: string;
    customer_name: string | null;
    line_count: string;
    pay_method: string | null;
    credit_total: string;
    has_installment_plan: boolean;
  }>(
    `SELECT o.id, o.order_number, o.total, o.closed_at, c.name AS customer_name,
            (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.id) AS line_count,
            (SELECT p.method::text FROM payments p WHERE p.order_id = o.id ORDER BY p.received_at LIMIT 1) AS pay_method,
            COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.order_id = o.id AND p.method = 'credit'), 0)::text AS credit_total,
            EXISTS (SELECT 1 FROM installments ip WHERE ip.business_id = $2 AND ip.invoice_order_id = o.id) AS has_installment_plan
       FROM orders o
       LEFT JOIN parties c ON c.id = o.customer_id
      WHERE o.location_id = $1 AND o.type = 'retail'
      ORDER BY o.order_number DESC`,
    [location.id, session.businessId],
  );

  let invoices = rows.map((r) => ({
    id: r.id,
    orderNumber: Number(r.order_number),
    total: Number(r.total),
    closedAt: r.closed_at,
    customerName: r.customer_name,
    lineCount: Number(r.line_count),
    paymentMethod: r.pay_method,
    creditTotal: Number(r.credit_total),
    hasInstallmentPlan: r.has_installment_plan,
  }));
  if (installmentEligible) {
    invoices = invoices.filter((inv) => inv.creditTotal > 0 && !inv.hasInstallmentPlan);
  }
  if (q) {
    invoices = invoices.filter(
      (inv) => (inv.customerName ?? "").includes(q) || String(inv.orderNumber).includes(q),
    );
  }
  if (method) {
    invoices = invoices.filter((inv) =>
      method === "credit" && installmentEligible ? inv.creditTotal > 0 : inv.paymentMethod === method,
    );
  }

  const count = invoices.length;
  const start = (page - 1) * pageSize;
  return NextResponse.json({ invoices: invoices.slice(start, start + pageSize), count });
});
