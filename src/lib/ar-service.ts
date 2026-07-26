/**
 * Phase 16 — AR subledger, the DB-touching part.
 *
 * A customer's balance, statement, and aging are all reconstructed from the
 * same source: every journal line ever posted to the Accounts Receivable
 * account, attributed to a customer via the order (source_type='order') or
 * receipt (source_type='ar_receipt') that caused it. This is the same
 * "compute from the ledger, never a shadow copy" discipline the financial
 * statements use (reports-service.ts), so a customer's balance always agrees
 * with the control account to the Rial by construction rather than by care.
 *
 * DB-touching, so per repo convention it has no direct unit test; the pure
 * aging math lives in ar.ts and is what ar.test.ts covers. Covered here by
 * integration/ar.integration.test.ts.
 */
import { getPool, query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountIdsByCode, MissingLedgerAccountError, postJournalEntry } from "./ledger-service";
import { ageInvoices, summarizeAging, type AgingSummary } from "./ar";

export { MissingLedgerAccountError };

/** Group key for AR lines that carry no customer attribution — a manual journal entry against A/R, or a credit order predating this feature. */
export const UNKNOWN_CUSTOMER_KEY = "unknown";

export class ArError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

async function arAccountId(businessId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
    [businessId, WELL_KNOWN_CODES.accountsReceivable],
  );
  return rows[0]?.id ?? null;
}

interface ArLineRow extends Record<string, unknown> {
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  entry_date: string;
  source_type: string | null;
  order_number: string | number | null;
  memo: string | null;
  debit: string;
  credit: string;
}

/** Every journal line posted to the AR account, oldest first, with whatever customer it's attributable to. */
async function arLines(businessId: string, accountId: string): Promise<ArLineRow[]> {
  const { rows } = await query<ArLineRow>(
    `SELECT c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
            je.entry_date::text AS entry_date, je.source_type, o.order_number, je.memo,
            jl.debit, jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       LEFT JOIN orders o ON je.source_type = 'order' AND o.id = je.source_id
       LEFT JOIN ar_receipts r ON je.source_type = 'ar_receipt' AND r.id = je.source_id
       LEFT JOIN customers c ON c.id = COALESCE(o.customer_id, r.customer_id)
      WHERE je.business_id = $1 AND jl.account_id = $2
      ORDER BY je.entry_date, je.posted_at`,
    [businessId, accountId],
  );
  return rows;
}

export interface CustomerBalance {
  customerId: string; // UNKNOWN_CUSTOMER_KEY for unattributed lines
  customerName: string;
  customerPhone: string | null;
  balance: number;
}

/** Every customer with a nonzero AR balance, largest first. */
export async function listCustomerBalances(businessId: string): Promise<CustomerBalance[]> {
  const accountId = await arAccountId(businessId);
  if (!accountId) return [];
  const lines = await arLines(businessId, accountId);

  const byCustomer = new Map<string, CustomerBalance>();
  for (const l of lines) {
    const key = l.customer_id ?? UNKNOWN_CUSTOMER_KEY;
    const entry = byCustomer.get(key) ?? {
      customerId: key,
      customerName: l.customer_name ?? "بدون مشتری مشخص",
      customerPhone: l.customer_phone,
      balance: 0,
    };
    entry.balance += Number(l.debit) - Number(l.credit);
    byCustomer.set(key, entry);
  }
  return [...byCustomer.values()].filter((c) => c.balance !== 0).sort((a, b) => b.balance - a.balance);
}

export interface ArStatementLine {
  date: string;
  type: "invoice" | "receipt" | "other";
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

/** One customer's full activity against A/R, oldest first, with a running balance. `customerId` may be UNKNOWN_CUSTOMER_KEY. */
export async function getCustomerStatement(businessId: string, customerId: string): Promise<ArStatementLine[]> {
  const accountId = await arAccountId(businessId);
  if (!accountId) return [];
  const lines = await arLines(businessId, accountId);
  const filtered = lines.filter((l) => (l.customer_id ?? UNKNOWN_CUSTOMER_KEY) === customerId);

  let balance = 0;
  return filtered.map((l) => {
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    balance += debit - credit;
    const type = l.source_type === "order" ? "invoice" : l.source_type === "ar_receipt" ? "receipt" : "other";
    const description =
      type === "invoice" && l.order_number != null
        ? `سفارش #${l.order_number}`
        : (l.memo ?? (type === "receipt" ? "دریافت وجه" : "سند دستی"));
    return { date: l.entry_date, type, description, debit, credit, balance };
  });
}

export interface AgingRow extends AgingSummary {
  customerId: string;
  customerName: string;
}

export interface AgingReport {
  asOfDate: string;
  rows: AgingRow[];
  totals: AgingSummary;
}

/** Standard 30/60/90-day AR aging, per customer, as of `asOfDate` (defaults to today). */
export async function getArAging(businessId: string, asOfDate?: string): Promise<AgingReport> {
  const effectiveAsOf = asOfDate ?? new Date().toISOString().slice(0, 10);
  const accountId = await arAccountId(businessId);
  if (!accountId) return { asOfDate: effectiveAsOf, rows: [], totals: { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 } };

  const lines = (await arLines(businessId, accountId)).filter((l) => l.entry_date <= effectiveAsOf);

  const byCustomer = new Map<string, { name: string; invoices: { id: string; date: string; amount: number }[]; receipts: { id: string; date: string; amount: number }[] }>();
  lines.forEach((l, i) => {
    const key = l.customer_id ?? UNKNOWN_CUSTOMER_KEY;
    const entry = byCustomer.get(key) ?? { name: l.customer_name ?? "بدون مشتری مشخص", invoices: [], receipts: [] };
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    if (debit > 0) entry.invoices.push({ id: `${key}-${i}`, date: l.entry_date, amount: debit });
    if (credit > 0) entry.receipts.push({ id: `${key}-${i}`, date: l.entry_date, amount: credit });
    byCustomer.set(key, entry);
  });

  const rows: AgingRow[] = [];
  const totals: AgingSummary = { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };
  for (const [customerId, { name, invoices, receipts }] of byCustomer) {
    const aged = ageInvoices(invoices, receipts, effectiveAsOf);
    const summary = summarizeAging(aged);
    if (summary.total === 0) continue;
    rows.push({ customerId, customerName: name, ...summary });
    totals.current += summary.current;
    totals.d31_60 += summary.d31_60;
    totals.d61_90 += summary.d61_90;
    totals.over90 += summary.over90;
    totals.total += summary.total;
  }
  rows.sort((a, b) => b.total - a.total);
  return { asOfDate: effectiveAsOf, rows, totals };
}

export interface ArReceipt {
  id: string;
  customerId: string;
  receiptDate: string;
  method: "cash" | "bank";
  amount: number;
  memo: string | null;
}

/**
 * Records a customer paying down their AR balance: Debit Cash/Bank-Clearing,
 * Credit Accounts Receivable, in the same transaction as the ar_receipts row
 * both reference (source_type='ar_receipt', source_id=receipt.id).
 */
export async function receivePayment(params: {
  businessId: string;
  locationId: string | null;
  customerId: string;
  method: "cash" | "bank";
  amount: number;
  receiptDate?: string | null;
  memo?: string | null;
  createdBy: string | null;
}): Promise<ArReceipt> {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
    throw new ArError("invalid_amount");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: customerRows } = await client.query<{ id: string }>(
      `SELECT id FROM customers WHERE id = $1 AND business_id = $2`,
      [params.customerId, params.businessId],
    );
    if (!customerRows[0]) throw new ArError("customer_not_found", 404);

    const accounts = await accountIdsByCode(client, params.businessId, [
      WELL_KNOWN_CODES.accountsReceivable,
      params.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing,
    ]);
    const arAccount = accounts.get(WELL_KNOWN_CODES.accountsReceivable)!;
    const cashAccount = accounts.get(params.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing)!;

    const { rows } = await client.query<{
      id: string;
      customer_id: string;
      receipt_date: string;
      method: "cash" | "bank";
      amount: string;
      memo: string | null;
    }>(
      `INSERT INTO ar_receipts (business_id, location_id, customer_id, receipt_date, method, amount, memo, created_by)
       VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, $6, $7, $8)
       RETURNING id, customer_id, receipt_date::text AS receipt_date, method, amount::text AS amount, memo`,
      [
        params.businessId,
        params.locationId,
        params.customerId,
        params.receiptDate ?? null,
        params.method,
        params.amount,
        params.memo?.trim() || null,
        params.createdBy,
      ],
    );
    const receipt = rows[0];

    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: receipt.receipt_date,
      memo: params.memo?.trim() || "دریافت وجه از مشتری",
      sourceType: "ar_receipt",
      sourceId: receipt.id,
      createdBy: params.createdBy,
      postingKind: "ar_receipt",
      lines: [
        { accountId: cashAccount, debit: params.amount, credit: 0 },
        { accountId: arAccount, debit: 0, credit: params.amount },
      ],
    });

    await client.query("COMMIT");
    return {
      id: receipt.id,
      customerId: receipt.customer_id,
      receiptDate: receipt.receipt_date,
      method: receipt.method,
      amount: Number(receipt.amount),
      memo: receipt.memo,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
