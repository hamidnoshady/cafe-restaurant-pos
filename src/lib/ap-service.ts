/**
 * Phase 16 — AP subledger, the DB-touching part. Mirrors ar-service.ts, with
 * two structural differences from AR:
 *
 * - Accounts Payable is a liability: its normal balance is credit-debit
 *   (the opposite sign convention from AR's asset debit-credit), so "an open
 *   item" is a credit line here and "a payment" is a debit line — backwards
 *   from ar-service.ts everywhere the two would otherwise look identical.
 * - A bill's supplier comes from the purchase that raised it (`purchases.
 *   supplier_id`, required for a `credit`-settled purchase since this phase
 *   — see the validation in the purchases receive route), or transitively
 *   from the purchase a supplier_return's `purchase_id` points at, since a
 *   return that credits/debits Accounts Payable also affects the balance.
 *   `suppliers` itself has no `business_id` column (only `location_id`), so
 *   payBill verifies the business match through `locations` explicitly
 *   rather than a plain equality check.
 *
 * DB-touching, so per repo convention it has no direct unit test; the pure
 * aging math (shared with AR) lives in aging.ts. Covered here by
 * integration/ap.integration.test.ts.
 */
import { getPool, query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountIdsByCode, MissingLedgerAccountError, postJournalEntry } from "./ledger-service";
import { ageOpenItems, summarizeAging, type AgingSummary } from "./aging";

export { MissingLedgerAccountError };

/** Group key for AP lines that carry no supplier attribution — a manual journal entry against A/P, or a credit purchase predating this feature. */
export const UNKNOWN_SUPPLIER_KEY = "unknown";

export class ApError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

async function apAccountId(businessId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
    [businessId, WELL_KNOWN_CODES.accountsPayable],
  );
  return rows[0]?.id ?? null;
}

interface ApLineRow extends Record<string, unknown> {
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_phone: string | null;
  entry_date: string;
  source_type: string | null;
  note: string | null;
  memo: string | null;
  debit: string;
  credit: string;
}

/** Every journal line posted to the AP account, oldest first, with whatever supplier it's attributable to. */
async function apLines(businessId: string, accountId: string): Promise<ApLineRow[]> {
  const { rows } = await query<ApLineRow>(
    `SELECT s.id AS supplier_id, s.name AS supplier_name, s.phone AS supplier_phone,
            je.entry_date::text AS entry_date, je.source_type,
            COALESCE(p.note, p2.note) AS note, je.memo,
            jl.debit, jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       LEFT JOIN purchases p ON je.source_type = 'purchase' AND p.id = je.source_id
       LEFT JOIN supplier_returns sr ON je.source_type = 'supplier_return' AND sr.id = je.source_id
       LEFT JOIN purchases p2 ON sr.purchase_id = p2.id
       LEFT JOIN ap_payments ap ON je.source_type = 'ap_payment' AND ap.id = je.source_id
       LEFT JOIN suppliers s ON s.id = COALESCE(p.supplier_id, p2.supplier_id, ap.supplier_id)
      WHERE je.business_id = $1 AND jl.account_id = $2
      ORDER BY je.entry_date, je.posted_at`,
    [businessId, accountId],
  );
  return rows;
}

export interface SupplierBalance {
  supplierId: string; // UNKNOWN_SUPPLIER_KEY for unattributed lines
  supplierName: string;
  supplierPhone: string | null;
  balance: number;
}

/** Every supplier with a nonzero AP balance, largest first. */
export async function listSupplierBalances(businessId: string): Promise<SupplierBalance[]> {
  const accountId = await apAccountId(businessId);
  if (!accountId) return [];
  const lines = await apLines(businessId, accountId);

  const bySupplier = new Map<string, SupplierBalance>();
  for (const l of lines) {
    const key = l.supplier_id ?? UNKNOWN_SUPPLIER_KEY;
    const entry = bySupplier.get(key) ?? {
      supplierId: key,
      supplierName: l.supplier_name ?? "بدون تأمین‌کننده مشخص",
      supplierPhone: l.supplier_phone,
      balance: 0,
    };
    // Liability normal balance: credit-debit.
    entry.balance += Number(l.credit) - Number(l.debit);
    bySupplier.set(key, entry);
  }
  return [...bySupplier.values()].filter((s) => s.balance !== 0).sort((a, b) => b.balance - a.balance);
}

export interface ApStatementLine {
  date: string;
  type: "bill" | "payment" | "return" | "other";
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

/** One supplier's full activity against A/P, oldest first, with a running balance. `supplierId` may be UNKNOWN_SUPPLIER_KEY. */
export async function getSupplierStatement(businessId: string, supplierId: string): Promise<ApStatementLine[]> {
  const accountId = await apAccountId(businessId);
  if (!accountId) return [];
  const lines = await apLines(businessId, accountId);
  const filtered = lines.filter((l) => (l.supplier_id ?? UNKNOWN_SUPPLIER_KEY) === supplierId);

  let balance = 0;
  return filtered.map((l) => {
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    balance += credit - debit;
    const type: ApStatementLine["type"] =
      l.source_type === "purchase" ? "bill" : l.source_type === "ap_payment" ? "payment" : l.source_type === "supplier_return" ? "return" : "other";
    const description =
      type === "bill"
        ? (l.note ?? "فاکتور خرید")
        : type === "payment"
          ? (l.memo ?? "پرداخت به تأمین‌کننده")
          : type === "return"
            ? "برگشت به تأمین‌کننده"
            : (l.memo ?? "سند دستی");
    return { date: l.entry_date, type, description, debit, credit, balance };
  });
}

export interface AgingRow extends AgingSummary {
  supplierId: string;
  supplierName: string;
}

export interface AgingReport {
  asOfDate: string;
  rows: AgingRow[];
  totals: AgingSummary;
}

/** Standard 30/60/90-day AP aging, per supplier, as of `asOfDate` (defaults to today). */
export async function getApAging(businessId: string, asOfDate?: string): Promise<AgingReport> {
  const effectiveAsOf = asOfDate ?? new Date().toISOString().slice(0, 10);
  const accountId = await apAccountId(businessId);
  if (!accountId) return { asOfDate: effectiveAsOf, rows: [], totals: { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 } };

  const lines = (await apLines(businessId, accountId)).filter((l) => l.entry_date <= effectiveAsOf);

  const bySupplier = new Map<string, { name: string; bills: { id: string; date: string; amount: number }[]; payments: { id: string; date: string; amount: number }[] }>();
  lines.forEach((l, i) => {
    const key = l.supplier_id ?? UNKNOWN_SUPPLIER_KEY;
    const entry = bySupplier.get(key) ?? { name: l.supplier_name ?? "بدون تأمین‌کننده مشخص", bills: [], payments: [] };
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    // Liability: a credit raises the bill, a debit (payment or return) pays it down.
    if (credit > 0) entry.bills.push({ id: `${key}-${i}`, date: l.entry_date, amount: credit });
    if (debit > 0) entry.payments.push({ id: `${key}-${i}`, date: l.entry_date, amount: debit });
    bySupplier.set(key, entry);
  });

  const rows: AgingRow[] = [];
  const totals: AgingSummary = { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };
  for (const [supplierId, { name, bills, payments }] of bySupplier) {
    const aged = ageOpenItems(bills, payments, effectiveAsOf);
    const summary = summarizeAging(aged);
    if (summary.total === 0) continue;
    rows.push({ supplierId, supplierName: name, ...summary });
    totals.current += summary.current;
    totals.d31_60 += summary.d31_60;
    totals.d61_90 += summary.d61_90;
    totals.over90 += summary.over90;
    totals.total += summary.total;
  }
  rows.sort((a, b) => b.total - a.total);
  return { asOfDate: effectiveAsOf, rows, totals };
}

export interface ApPayment {
  id: string;
  supplierId: string;
  paymentDate: string;
  method: "cash" | "bank";
  amount: number;
  memo: string | null;
}

/**
 * Records the business paying down a supplier's AP balance: Debit Accounts
 * Payable, Credit Cash/Bank-Clearing, in the same transaction as the
 * ap_payments row both reference (source_type='ap_payment',
 * source_id=payment.id).
 */
export async function payBill(params: {
  businessId: string;
  locationId: string | null;
  supplierId: string;
  method: "cash" | "bank";
  amount: number;
  paymentDate?: string | null;
  memo?: string | null;
  createdBy: string | null;
}): Promise<ApPayment> {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
    throw new ApError("invalid_amount");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // suppliers has no business_id column — verify the match through its
    // (mandatory) location instead.
    const { rows: supplierRows } = await client.query<{ id: string }>(
      `SELECT s.id FROM suppliers s JOIN locations l ON l.id = s.location_id
        WHERE s.id = $1 AND l.business_id = $2`,
      [params.supplierId, params.businessId],
    );
    if (!supplierRows[0]) throw new ApError("supplier_not_found", 404);

    const accounts = await accountIdsByCode(client, params.businessId, [
      WELL_KNOWN_CODES.accountsPayable,
      params.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing,
    ]);
    const apAccount = accounts.get(WELL_KNOWN_CODES.accountsPayable)!;
    const cashAccount = accounts.get(params.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing)!;

    const { rows } = await client.query<{
      id: string;
      supplier_id: string;
      payment_date: string;
      method: "cash" | "bank";
      amount: string;
      memo: string | null;
    }>(
      `INSERT INTO ap_payments (business_id, location_id, supplier_id, payment_date, method, amount, memo, created_by)
       VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, $6, $7, $8)
       RETURNING id, supplier_id, payment_date::text AS payment_date, method, amount::text AS amount, memo`,
      [
        params.businessId,
        params.locationId,
        params.supplierId,
        params.paymentDate ?? null,
        params.method,
        params.amount,
        params.memo?.trim() || null,
        params.createdBy,
      ],
    );
    const payment = rows[0];

    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: payment.payment_date,
      memo: params.memo?.trim() || "پرداخت به تأمین‌کننده",
      sourceType: "ap_payment",
      sourceId: payment.id,
      createdBy: params.createdBy,
      postingKind: "ap_payment",
      lines: [
        { accountId: apAccount, debit: params.amount, credit: 0 },
        { accountId: cashAccount, debit: 0, credit: params.amount },
      ],
    });

    await client.query("COMMIT");
    return {
      id: payment.id,
      supplierId: payment.supplier_id,
      paymentDate: payment.payment_date,
      method: payment.method,
      amount: Number(payment.amount),
      memo: payment.memo,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
