import { getPool, query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountIdsByCode, MissingLedgerAccountError, postJournalEntry } from "./ledger-service";
import { isoDateToJalali, jalaliMonthLength, jalaliToIsoDate } from "./jalali";

/**
 * Installment schedules (اقساط) — see migrations/0140_installments.sql for the
 * data model and the "schedule posts when the slice settles" contract.
 */

export class InstallmentError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export type InstallmentDirection = "receivable" | "payable";

export interface InstallmentPlanInput {
  businessId: string;
  locationId: string | null;
  direction: InstallmentDirection;
  source: "party" | "invoice";
  partyId?: string | null;
  invoiceOrderId?: string | null;
  /** Integer Rial; ignored (derived from the order) for invoice plans. */
  principal: number;
  downPayment?: number;
  interestPercent?: number;
  lateFeePercent?: number;
  installmentCount: number;
  intervalMonths: number;
  firstDueDate: string; // ISO YYYY-MM-DD
  note?: string | null;
  createdBy: string | null;
}

export interface InstallmentItemRow {
  id: string;
  seq: number;
  dueDate: string;
  amount: number;
  paidAt: string | null;
  paidMethod: "cash" | "bank" | null;
  paidMemo: string | null;
}

export interface InstallmentPlanRow {
  id: string;
  direction: InstallmentDirection;
  source: "party" | "invoice";
  partyId: string | null;
  partyName: string | null;
  invoiceOrderId: string | null;
  invoiceOrderNumber: number | null;
  principal: number;
  downPayment: number;
  interestPercent: number;
  lateFeePercent: number;
  installmentCount: number;
  intervalMonths: number;
  firstDueDate: string;
  note: string | null;
  createdAt: string;
  paidTotal: number;
  remaining: number;
  paidCount: number;
  nextDueDate: string | null;
  status: "open" | "overdue" | "settled";
  items?: InstallmentItemRow[];
}

/** Adds Jalali months to an ISO date, clamping the day into the target month. */
export function addJalaliMonths(iso: string, months: number): string {
  const j = isoDateToJalali(iso);
  if (!j) return iso;
  const total = j.jm - 1 + months;
  const jy = j.jy + Math.floor(total / 12);
  const jm = (total % 12) + 1;
  const jd = Math.min(j.jd, jalaliMonthLength(jy, jm));
  return jalaliToIsoDate(jy, jm, jd);
}

function planStatus(paidCount: number, count: number, nextDueDate: string | null): "open" | "overdue" | "settled" {
  if (paidCount >= count) return "settled";
  if (nextDueDate && nextDueDate < new Date().toISOString().slice(0, 10)) return "overdue";
  return "open";
}

export async function createInstallmentPlan(input: InstallmentPlanInput): Promise<{ id: string }> {
  if (!Number.isSafeInteger(input.principal) || input.principal <= 0) throw new InstallmentError("invalid_amount");
  const downPayment = input.downPayment ?? 0;
  if (!Number.isSafeInteger(downPayment) || downPayment < 0) throw new InstallmentError("invalid_down_payment");
  if (!Number.isInteger(input.installmentCount) || input.installmentCount < 1 || input.installmentCount > 120) {
    throw new InstallmentError("invalid_installment_count");
  }
  if (!Number.isInteger(input.intervalMonths) || input.intervalMonths < 1 || input.intervalMonths > 36) {
    throw new InstallmentError("invalid_interval");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.firstDueDate)) throw new InstallmentError("invalid_due_date");
  const interestPercent = input.interestPercent ?? 0;
  const lateFeePercent = input.lateFeePercent ?? 0;
  if (interestPercent < 0 || interestPercent > 100 || lateFeePercent < 0 || lateFeePercent > 100) {
    throw new InstallmentError("invalid_percent");
  }

  let partyId = input.partyId?.trim() || null;
  let principal = input.principal;
  let invoiceOrderId: string | null = null;

  if (input.source === "invoice") {
    if (!input.invoiceOrderId) throw new InstallmentError("invoice_required");
    const { rows } = await query<{ id: string; total: string; customer_id: string | null }>(
      `SELECT o.id, o.total, o.customer_id FROM orders o
        JOIN locations l ON l.id = o.location_id
       WHERE o.id = $1 AND l.business_id = $2 AND o.type = 'retail'`,
      [input.invoiceOrderId, input.businessId],
    );
    if (!rows[0]) throw new InstallmentError("invoice_not_found", 404);
    if (!rows[0].customer_id) throw new InstallmentError("invoice_has_no_customer");
    invoiceOrderId = rows[0].id;
    partyId = rows[0].customer_id;
    principal = Number(rows[0].total);
  } else if (!partyId) {
    throw new InstallmentError("party_required");
  }

  if (partyId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM parties WHERE id = $1 AND business_id = $2`,
      [partyId, input.businessId],
    );
    if (!rows[0]) throw new InstallmentError("party_not_found", 404);
    if (input.direction === "payable") {
      // Settling a payable slice posts an ap_payments row, which needs the
      // party's per-location supplier record — refuse the plan up front
      // rather than at the first slice.
      const { rows: supplierRows } = await query<{ id: string }>(
        `SELECT s.id FROM suppliers s JOIN locations l ON l.id = s.location_id
          WHERE s.party_id = $1 AND l.business_id = $2 LIMIT 1`,
        [partyId, input.businessId],
      );
      if (!supplierRows[0]) throw new InstallmentError("supplier_record_missing", 409);
    }
  }

  const financed = principal - downPayment;
  if (financed <= 0) throw new InstallmentError("down_payment_exceeds_principal");
  const withInterest = Math.round(financed * (1 + interestPercent / 100));
  const perItem = Math.floor(withInterest / input.installmentCount);
  if (perItem <= 0) throw new InstallmentError("installment_amount_too_small");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO installments (business_id, location_id, direction, source, party_id, invoice_order_id,
                                 principal, down_payment, interest_percent, late_fee_percent,
                                 installment_count, interval_months, first_due_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [
        input.businessId,
        input.locationId,
        input.direction,
        input.source,
        partyId,
        invoiceOrderId,
        principal,
        downPayment,
        interestPercent,
        lateFeePercent,
        input.installmentCount,
        input.intervalMonths,
        input.firstDueDate,
        input.note?.trim() || null,
        input.createdBy,
      ],
    );
    const planId = rows[0].id;
    for (let seq = 1; seq <= input.installmentCount; seq += 1) {
      const amount = seq === input.installmentCount ? withInterest - perItem * (input.installmentCount - 1) : perItem;
      const dueDate = addJalaliMonths(input.firstDueDate, (seq - 1) * input.intervalMonths);
      await client.query(
        `INSERT INTO installment_items (installment_id, seq, due_date, amount) VALUES ($1, $2, $3, $4)`,
        [planId, seq, dueDate, amount],
      );
    }
    await client.query("COMMIT");
    return { id: planId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

interface PlanDbRow {
  [key: string]: unknown;
  id: string;
  direction: InstallmentDirection;
  source: "party" | "invoice";
  party_id: string | null;
  party_name: string | null;
  invoice_order_id: string | null;
  order_number: string | null;
  principal: string;
  down_payment: string;
  interest_percent: string;
  late_fee_percent: string;
  installment_count: string;
  interval_months: string;
  first_due_date: string;
  note: string | null;
  created_at: string;
  paid_total: string | null;
  paid_count: string | null;
  next_due_date: string | null;
}

function mapPlanRow(r: PlanDbRow, items?: InstallmentItemRow[]): InstallmentPlanRow {
  const count = Number(r.installment_count);
  const paidCount = Number(r.paid_count ?? 0);
  const principal = Number(r.principal);
  const paidTotal = Number(r.paid_total ?? 0);
  const nextDueDate = r.next_due_date ?? null;
  return {
    id: r.id,
    direction: r.direction,
    source: r.source,
    partyId: r.party_id,
    partyName: r.party_name,
    invoiceOrderId: r.invoice_order_id,
    invoiceOrderNumber: r.order_number ? Number(r.order_number) : null,
    principal,
    downPayment: Number(r.down_payment),
    interestPercent: Number(r.interest_percent),
    lateFeePercent: Number(r.late_fee_percent),
    installmentCount: count,
    intervalMonths: Number(r.interval_months),
    firstDueDate: r.first_due_date,
    note: r.note,
    createdAt: r.created_at,
    paidTotal,
    remaining: Math.max(principal - paidTotal, 0),
    paidCount,
    nextDueDate,
    status: planStatus(paidCount, count, nextDueDate),
    items,
  };
}

const PLAN_SELECT = `
  SELECT p.id, p.direction, p.source, p.party_id, pa.name AS party_name,
         p.invoice_order_id, o.order_number, p.principal, p.down_payment,
         p.interest_percent, p.late_fee_percent, p.installment_count,
         p.interval_months, p.first_due_date, p.note, p.created_at,
         (SELECT COALESCE(sum(i.amount), 0) FROM installment_items i
           WHERE i.installment_id = p.id AND i.paid_at IS NOT NULL) AS paid_total,
         (SELECT count(*) FROM installment_items i
           WHERE i.installment_id = p.id AND i.paid_at IS NOT NULL) AS paid_count,
         (SELECT min(i.due_date)::text FROM installment_items i
           WHERE i.installment_id = p.id AND i.paid_at IS NULL) AS next_due_date
    FROM installments p
    LEFT JOIN parties pa ON pa.id = p.party_id
    LEFT JOIN orders o ON o.id = p.invoice_order_id`;

export async function listInstallmentPlans(
  businessId: string,
  filters: { direction: InstallmentDirection; q?: string; status?: "open" | "settled" | "overdue" | "all" },
): Promise<InstallmentPlanRow[]> {
  const { rows } = await query<PlanDbRow>(
    `${PLAN_SELECT}
     WHERE p.business_id = $1 AND p.direction = $2
     ORDER BY p.created_at DESC, p.id`,
    [businessId, filters.direction],
  );
  const q = filters.q?.trim();
  let plans = rows.map((r) => mapPlanRow(r));
  if (q) {
    plans = plans.filter(
      (p) =>
        (p.partyName ?? "").includes(q) ||
        (p.invoiceOrderNumber !== null && String(p.invoiceOrderNumber).includes(q)),
    );
  }
  const status = filters.status ?? "all";
  if (status !== "all") plans = plans.filter((p) => p.status === status);
  return plans;
}

export async function getInstallmentPlan(businessId: string, planId: string): Promise<InstallmentPlanRow | null> {
  const { rows } = await query<PlanDbRow>(`${PLAN_SELECT} WHERE p.business_id = $1 AND p.id = $2`, [businessId, planId]);
  if (!rows[0]) return null;
  const { rows: itemRows } = await query<{
    id: string;
    seq: string;
    due_date: string;
    amount: string;
    paid_at: string | null;
    paid_method: "cash" | "bank" | null;
    paid_memo: string | null;
  }>(
    `SELECT id, seq, due_date::text AS due_date, amount::text AS amount,
            paid_at::text AS paid_at, paid_method, paid_memo
       FROM installment_items WHERE installment_id = $1 ORDER BY seq`,
    [planId],
  );
  return mapPlanRow(rows[0], itemRows.map((i) => ({
    id: i.id,
    seq: Number(i.seq),
    dueDate: i.due_date,
    amount: Number(i.amount),
    paidAt: i.paid_at,
    paidMethod: i.paid_method,
    paidMemo: i.paid_memo,
  })));
}

/**
 * Settles one slice. Receivable slices post the exact ar_receipt pair
 * (Debit Cash/Bank / Credit A/R); payable slices the ap_payments mirror —
 * in the same transaction that marks the slice paid, so plan and ledger
 * cannot disagree.
 */
export async function payInstallmentItem(params: {
  businessId: string;
  locationId: string | null;
  planId: string;
  itemId: string;
  method: "cash" | "bank";
  memo?: string | null;
  createdBy: string | null;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: planRows } = await client.query<{
      id: string;
      direction: InstallmentDirection;
      party_id: string | null;
      party_name: string | null;
    }>(
      `SELECT p.id, p.direction, p.party_id, pa.name AS party_name
         FROM installments p LEFT JOIN parties pa ON pa.id = p.party_id
        WHERE p.business_id = $1 AND p.id = $2`,
      [params.businessId, params.planId],
    );
    const plan = planRows[0];
    if (!plan) throw new InstallmentError("plan_not_found", 404);
    if (!plan.party_id) throw new InstallmentError("plan_has_no_party");

    const { rows: itemRows } = await client.query<{ id: string; amount: string; paid_at: string | null; seq: string }>(
      `SELECT id, amount::text AS amount, paid_at::text AS paid_at, seq::text AS seq
         FROM installment_items WHERE id = $1 AND installment_id = $2`,
      [params.itemId, params.planId],
    );
    const item = itemRows[0];
    if (!item) throw new InstallmentError("item_not_found", 404);
    if (item.paid_at) throw new InstallmentError("already_paid");
    const amount = Number(item.amount);

    const accounts = await accountIdsByCode(client, params.businessId, [
      WELL_KNOWN_CODES.accountsReceivable,
      WELL_KNOWN_CODES.accountsPayable,
      params.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing,
    ]);
    const cashAccount = accounts.get(params.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing)!;

    const memo = params.memo?.trim() || `قسط ${item.seq} — ${plan.party_name ?? ""}`;

    if (plan.direction === "receivable") {
      const arAccount = accounts.get(WELL_KNOWN_CODES.accountsReceivable)!;
      const { rows } = await client.query<{ id: string; receipt_date: string }>(
        `INSERT INTO ar_receipts (business_id, location_id, customer_id, receipt_date, method, amount, memo, created_by)
         VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7) RETURNING id, receipt_date::text AS receipt_date`,
        [params.businessId, params.locationId, plan.party_id, params.method, amount, memo, params.createdBy],
      );
      await postJournalEntry(client, {
        businessId: params.businessId,
        locationId: params.locationId,
        entryDate: rows[0].receipt_date,
        memo,
        sourceType: "ar_receipt",
        sourceId: rows[0].id,
        createdBy: params.createdBy,
        postingKind: "ar_receipt",
        lines: [
          { accountId: cashAccount, debit: amount, credit: 0 },
          { accountId: arAccount, debit: 0, credit: amount },
        ],
      });
      await client.query(
        `UPDATE installment_items SET paid_at = now(), paid_method = $1, paid_memo = $2, receipt_id = $3 WHERE id = $4`,
        [params.method, params.memo?.trim() || null, rows[0].id, params.itemId],
      );
    } else {
      // ap_payments points at the per-location supplier row, not the party.
      const { rows: supplierRows } = await client.query<{ id: string }>(
        `SELECT s.id FROM suppliers s JOIN locations l ON l.id = s.location_id
          WHERE s.party_id = $1 AND l.business_id = $2 LIMIT 1`,
        [plan.party_id, params.businessId],
      );
      if (!supplierRows[0]) throw new InstallmentError("supplier_record_missing", 409);
      const apAccount = accounts.get(WELL_KNOWN_CODES.accountsPayable)!;
      const { rows } = await client.query<{ id: string; payment_date: string }>(
        `INSERT INTO ap_payments (business_id, location_id, supplier_id, payment_date, method, amount, memo, created_by)
         VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7) RETURNING id, payment_date::text AS payment_date`,
        [params.businessId, params.locationId, supplierRows[0].id, params.method, amount, memo, params.createdBy],
      );
      await postJournalEntry(client, {
        businessId: params.businessId,
        locationId: params.locationId,
        entryDate: rows[0].payment_date,
        memo,
        sourceType: "ap_payment",
        sourceId: rows[0].id,
        createdBy: params.createdBy,
        postingKind: "ap_payment",
        lines: [
          { accountId: apAccount, debit: amount, credit: 0 },
          { accountId: cashAccount, debit: 0, credit: amount },
        ],
      });
      await client.query(
        `UPDATE installment_items SET paid_at = now(), paid_method = $1, paid_memo = $2, payment_id = $3 WHERE id = $4`,
        [params.method, params.memo?.trim() || null, rows[0].id, params.itemId],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Lists receipt vouchers — the «دریافت‌ها» ledger slice. */
export async function listReceipts(businessId: string, q?: string) {
  const { rows } = await query<{
    id: string;
    receipt_date: string;
    method: "cash" | "bank";
    amount: string;
    memo: string | null;
    party_name: string | null;
  }>(
    `SELECT r.id, r.receipt_date::text AS receipt_date, r.method, r.amount::text AS amount, r.memo, p.name AS party_name
       FROM ar_receipts r LEFT JOIN parties p ON p.id = r.customer_id
      WHERE r.business_id = $1
      ORDER BY r.receipt_date DESC, r.created_at DESC`,
    [businessId],
  );
  const needle = q?.trim();
  return rows
    .map((r) => ({
      id: r.id,
      date: r.receipt_date,
      method: r.method,
      amount: Number(r.amount),
      memo: r.memo,
      partyName: r.party_name ?? "بدون مشتری مشخص",
    }))
    .filter((r) => !needle || r.partyName.includes(needle) || (r.memo ?? "").includes(needle));
}

/** Lists payment vouchers — the «پرداخت‌ها» ledger slice. */
export async function listPayments(businessId: string, q?: string) {
  const { rows } = await query<{
    id: string;
    payment_date: string;
    method: "cash" | "bank";
    amount: string;
    memo: string | null;
    party_name: string | null;
  }>(
    `SELECT p.id, p.payment_date::text AS payment_date, p.method, p.amount::text AS amount, p.memo, pa.name AS party_name
       FROM ap_payments p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN parties pa ON pa.id = s.party_id
      WHERE p.business_id = $1
      ORDER BY p.payment_date DESC, p.created_at DESC`,
    [businessId],
  );
  const needle = q?.trim();
  return rows
    .map((r) => ({
      id: r.id,
      date: r.payment_date,
      method: r.method,
      amount: Number(r.amount),
      memo: r.memo,
      partyName: r.party_name ?? "تأمین‌کننده",
    }))
    .filter((r) => !needle || r.partyName.includes(needle) || (r.memo ?? "").includes(needle));
}

export { MissingLedgerAccountError };
