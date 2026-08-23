/**
 * Phase 32 — gathers the snapshot `accounting-review.ts` reasons over.
 *
 * The split is the same one the rest of `src/lib` uses: every query lives
 * here, every judgement lives in the pure module, so "what counts as wrong"
 * stays unit-testable against fixtures and this file stays a list of SELECTs.
 *
 * Everything is read inside the caller's tenant scope, so RLS is the boundary
 * exactly as it is in a request. A query that fails (a table a future release
 * drops, a permission edge) degrades that one rule to "found nothing" rather
 * than taking the whole review down — a review that half-runs is far more
 * useful than one that errors, and each rule is independent by construction.
 */
import { query } from "./db";
import {
  emptyAccountingSnapshot,
  reviewAccounting,
  type AccountingFinding,
  type AccountingReviewSnapshot,
} from "./accounting-review";
import { coaTemplateForIndustry } from "./coa-template";
import type { Industry } from "./industries";

const DEFAULT_WINDOW_DAYS = 30;

/**
 * Rules are independent, so one failing query must not lose the other eleven —
 * a review that half-runs is far more useful than one that errors.
 *
 * But a check that quietly returns "found nothing" when its query is broken is
 * indistinguishable from clean books, which is the worst possible failure for
 * an audit tool. So every degradation is also *named* in the result
 * (`unavailableChecks`), and the integration test asserts that list is empty —
 * a future schema change that breaks a query fails CI instead of silently
 * removing a check.
 */
async function safely<T>(
  label: string,
  fallback: T,
  degraded: string[],
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.error(`accounting review: ${label} failed:`, error instanceof Error ? error.message : error);
    degraded.push(label);
    return fallback;
  }
}

function isoDaysAgo(asOfDate: string, days: number): string {
  const atNoon = new Date(`${asOfDate}T12:00:00.000Z`);
  atNoon.setUTCDate(atNoon.getUTCDate() - days);
  return atNoon.toISOString().slice(0, 10);
}

export interface AccountingReviewOptions {
  asOfDate?: string;
  windowDays?: number;
}

export interface CollectedSnapshot {
  snapshot: AccountingReviewSnapshot;
  /** Checks whose query failed, so the caller can say so rather than imply clean books. */
  unavailableChecks: string[];
}

export async function collectAccountingSnapshot(
  businessId: string,
  options: AccountingReviewOptions = {},
): Promise<CollectedSnapshot> {
  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = isoDaysAgo(asOfDate, windowDays);
  const snapshot = emptyAccountingSnapshot(asOfDate, windowDays);
  const unavailableChecks: string[] = [];

  snapshot.unbalancedEntries = await safely("unbalanced entries", snapshot.unbalancedEntries, unavailableChecks, async () => {
    const { rows } = await query<{ id: string; entry_date: string; memo: string | null; debit: string; credit: string }>(
      `SELECT je.id, je.entry_date::text AS entry_date, je.memo,
              coalesce(sum(jl.debit), 0)::text  AS debit,
              coalesce(sum(jl.credit), 0)::text AS credit
         FROM journal_entries je
         LEFT JOIN journal_lines jl ON jl.entry_id = je.id
        WHERE je.business_id = $1
        GROUP BY je.id, je.entry_date, je.memo
       HAVING coalesce(sum(jl.debit), 0) <> coalesce(sum(jl.credit), 0)
        ORDER BY je.entry_date DESC
        LIMIT 50`,
      [businessId],
    );
    return rows.map((row) => ({
      id: row.id,
      entryDate: row.entry_date,
      memo: row.memo ?? "",
      debitRial: Number(row.debit),
      creditRial: Number(row.credit),
    }));
  });

  snapshot.unpostedInventoryEvents = await safely("unposted inventory events", snapshot.unpostedInventoryEvents, unavailableChecks, async () => {
    const { rows } = await query<{ id: string; event_type: string; effective_at: string; posting_status: string }>(
      `SELECT id, event_type::text AS event_type, effective_at::text AS effective_at,
              posting_status::text AS posting_status
         FROM inventory_events
        WHERE business_id = $1 AND posting_status <> 'posted'
        ORDER BY effective_at DESC
        LIMIT 50`,
      [businessId],
    );
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      occurredAt: row.effective_at,
      status: row.posting_status,
    }));
  });

  snapshot.pendingDrafts = await safely("pending journal drafts", snapshot.pendingDrafts, unavailableChecks, async () => {
    const { rows } = await query<{ id: string; memo: string; created_at: string; age_days: string; amount: string }>(
      `SELECT d.id, d.memo, d.created_at::text AS created_at,
              floor(extract(epoch FROM (now() - d.created_at)) / 86400)::text AS age_days,
              coalesce(sum(l.debit), 0)::text AS amount
         FROM journal_entry_drafts d
         LEFT JOIN journal_entry_draft_lines l ON l.draft_id = d.id
        WHERE d.business_id = $1
        GROUP BY d.id, d.memo, d.created_at
        ORDER BY d.created_at
        LIMIT 50`,
      [businessId],
    );
    return rows.map((row) => ({
      id: row.id,
      memo: row.memo,
      createdAt: row.created_at,
      ageDays: Number(row.age_days),
      amountRial: Number(row.amount),
    }));
  });

  snapshot.shiftVariances = await safely("shift variances", snapshot.shiftVariances, unavailableChecks, async () => {
    // Expected cash = what the employee started the drawer with plus the cash
    // they actually took. `closed_by`/`closed_at` on purpose, not the shift's
    // opened-in window: this asks "what is in this employee's till", which is
    // the same rule shiftCashSummary answers (see CLAUDE.md's business-day note).
    const { rows } = await query<{ shift_id: string; employee_name: string; ended_at: string; variance: string }>(
      `SELECT s.id AS shift_id,
              coalesce(u.full_name, 'بدون نام') AS employee_name,
              s.ended_at::text AS ended_at,
              (s.closing_float - (s.opening_float + coalesce(cash.total, 0)))::text AS variance
         FROM employee_shifts s
         LEFT JOIN users u ON u.id = s.employee_id
         LEFT JOIN LATERAL (
             SELECT coalesce(sum(p.amount) FILTER (WHERE p.method = 'cash'), 0) AS total
               FROM orders o
               LEFT JOIN payments p ON p.order_id = o.id
              WHERE o.closed_by = s.employee_id AND o.status = 'completed'
                AND o.closed_at BETWEEN s.started_at AND s.ended_at
         ) cash ON true
        WHERE s.business_id = $1
          AND s.ended_at IS NOT NULL
          AND s.ended_at >= $2::date
          AND s.opening_float IS NOT NULL
          AND s.closing_float IS NOT NULL
        ORDER BY s.ended_at DESC
        LIMIT 50`,
      [businessId, since],
    );
    return rows.map((row) => ({
      shiftId: row.shift_id,
      employeeName: row.employee_name,
      endedAt: row.ended_at,
      varianceRial: Number(row.variance),
    }));
  });

  snapshot.missingAccountCodes = await safely("missing accounts", snapshot.missingAccountCodes, unavailableChecks, async () => {
    // Measured against the business's OWN industry template rather than a
    // hard-coded list, so a jewellery shop is not told it is missing a café's
    // accounts — and so Phase 30's per-trade charts stay the one source.
    const { rows: businesses } = await query<{ industry: Industry }>(
      "SELECT industry FROM businesses WHERE id = $1",
      [businessId],
    );
    const template = coaTemplateForIndustry(businesses[0]?.industry ?? "food_service");
    const { rows } = await query<{ code: string }>(
      `SELECT code FROM accounts WHERE business_id = $1`,
      [businessId],
    );
    const present = new Set(rows.map((row) => row.code));
    return template
      .filter((account) => !present.has(account.code))
      .map((account) => ({ code: account.code, name: account.name }))
      .slice(0, 20);
  });

  snapshot.negativeStock = await safely("negative stock", snapshot.negativeStock, unavailableChecks, async () => {
    const { rows } = await query<{ id: string; name: string; quantity: string; unit: string }>(
      // On hand is the sum of the append-only stock ledger — `inventory_items`
      // has no quantity column of its own.
      `SELECT ii.id, ii.name, trim_scale(sm.total)::text AS quantity, ii.unit
         FROM inventory_items ii
         JOIN locations l ON l.id = ii.location_id
         JOIN LATERAL (
           SELECT COALESCE(sum(quantity), 0) AS total
             FROM stock_movements WHERE inventory_item_id = ii.id
         ) sm ON true
        WHERE l.business_id = $1 AND sm.total < 0
        ORDER BY sm.total
        LIMIT 50`,
      [businessId],
    );
    return rows;
  });

  snapshot.unreconciledBankLines = await safely("unreconciled bank lines", snapshot.unreconciledBankLines, unavailableChecks, async () => {
    const { rows } = await query<{ count: string; oldest_age: string | null; amount: string }>(
      `SELECT count(*)::text AS count,
              max(floor(extract(epoch FROM (now() - je.entry_date::timestamptz)) / 86400))::text AS oldest_age,
              coalesce(sum(jl.debit + jl.credit), 0)::text AS amount
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.business_id = $1
          AND a.code IN ('1110', '1120')
          AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_lines brl WHERE brl.journal_line_id = jl.id)`,
      [businessId],
    );
    const row = rows[0];
    return {
      count: Number(row?.count ?? 0),
      oldestAgeDays: row?.oldest_age === null || row?.oldest_age === undefined ? null : Number(row.oldest_age),
      amountRial: Number(row?.amount ?? 0),
    };
  });

  snapshot.closedOrdersWithoutEntry = await safely("orders without entry", snapshot.closedOrdersWithoutEntry, unavailableChecks, async () => {
    const { rows } = await query<{ id: string; reference: string; closed_at: string; total: string }>(
      `SELECT o.id, coalesce(o.order_number::text, o.id::text) AS reference,
              o.closed_at::text AS closed_at, o.total::text AS total
         FROM orders o
         JOIN locations l ON l.id = o.location_id
        WHERE l.business_id = $1
          AND o.status = 'completed'
          AND o.closed_at >= $2::date
          AND NOT EXISTS (
              SELECT 1 FROM journal_entries je
               WHERE je.business_id = $1 AND je.source_type = 'order' AND je.source_id = o.id
          )
        ORDER BY o.closed_at DESC
        LIMIT 50`,
      [businessId, since],
    );
    return rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      closedAt: row.closed_at,
      totalRial: Number(row.total),
    }));
  });

  snapshot.agedReceivables = await safely("aged receivables", snapshot.agedReceivables, unavailableChecks, async () => {
    const { getArAging } = await import("./ar-service");
    const aging = await getArAging(businessId, asOfDate);
    return aging.rows
      .filter((row) => row.d61_90 + row.over90 > 0)
      .slice(0, 20)
      .map((row) => ({
        customerId: row.customerId,
        customerName: row.customerName,
        amountRial: row.d61_90 + row.over90,
        // The bucket the balance actually sits in, not an exact invoice age —
        // which is what the aging report itself can answer.
        ageDays: row.over90 > 0 ? 90 : 60,
      }));
  });

  snapshot.overdueCheques = await safely("overdue cheques", snapshot.overdueCheques, unavailableChecks, async () => {
    const { rows } = await query<{
      id: string;
      serial_number: string;
      due_date: string;
      amount: string;
      direction: string;
      status: string;
    }>(
      `SELECT id, serial_number, due_date::text AS due_date, amount::text AS amount,
              direction::text AS direction, status::text AS status
         FROM cheques
        WHERE business_id = $1
          AND due_date < $2::date
          AND status IN ('on_hand', 'in_collection', 'issued', 'endorsed')
        ORDER BY due_date
        LIMIT 50`,
      [businessId, asOfDate],
    );
    return rows.map((row) => ({
      id: row.id,
      serialNumber: row.serial_number,
      dueDate: row.due_date,
      amountRial: Number(row.amount),
      direction: row.direction,
      status: row.status,
    }));
  });

  snapshot.staleDraftPurchases = await safely("stale draft purchases", snapshot.staleDraftPurchases, unavailableChecks, async () => {
    const { rows } = await query<{ id: string; supplier_name: string | null; created_at: string; age_days: string }>(
      `SELECT p.id, s.name AS supplier_name, p.created_at::text AS created_at,
              floor(extract(epoch FROM (now() - p.created_at)) / 86400)::text AS age_days
         FROM purchases p
         JOIN locations l ON l.id = p.location_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE l.business_id = $1 AND p.status = 'draft'
        ORDER BY p.created_at
        LIMIT 50`,
      [businessId],
    );
    return rows.map((row) => ({
      id: row.id,
      supplierName: row.supplier_name,
      createdAt: row.created_at,
      ageDays: Number(row.age_days),
    }));
  });

  snapshot.unlockedPastPeriods = await safely("unlocked periods", snapshot.unlockedPastPeriods, unavailableChecks, async () => {
    const { rows } = await query<{ id: string; label: string; ends_on: string }>(
      `SELECT id, label, ends_on::text AS ends_on
         FROM fiscal_periods
        WHERE business_id = $1 AND ends_on < $2::date AND status = 'open'
        ORDER BY ends_on
        LIMIT 20`,
      [businessId, asOfDate],
    );
    return rows.map((row) => ({ id: row.id, label: row.label, endsOn: row.ends_on }));
  });

  return { snapshot, unavailableChecks };
}

export interface AccountingReviewResult {
  asOfDate: string;
  windowDays: number;
  findings: AccountingFinding[];
  /** Empty in a healthy deployment. See `safely` for why it is reported at all. */
  unavailableChecks: string[];
}

/** The whole review: read the snapshot, then judge it. */
export async function runAccountingReview(
  businessId: string,
  options: AccountingReviewOptions = {},
): Promise<AccountingReviewResult> {
  const { snapshot, unavailableChecks } = await collectAccountingSnapshot(businessId, options);
  return {
    asOfDate: snapshot.asOfDate,
    windowDays: snapshot.windowDays,
    findings: reviewAccounting(snapshot),
    unavailableChecks,
  };
}
