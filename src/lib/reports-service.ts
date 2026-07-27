/**
 * DB-touching reporting orchestration (not unit-tested directly, per repo
 * convention — pure logic lives in reports.ts and is what *.test.ts covers).
 */
import { query, getPool } from "./db";
import {
  buildReportQuery,
  previousPeriodRange,
  REPORT_VIEWS,
  STANDARD_REPORTS,
  validateReportConfig,
  type ReportConfig,
  type ChartType,
} from "./reports";
import { addDays } from "./rollup";
import { WELL_KNOWN_CODES } from "./coa-template";
import type { Role } from "./auth";

export interface ReportRow extends Record<string, unknown> {
  dim: string | null;
  value: string | number | null;
}

/** Runs a validated custom (or standard) report config against its view. Throws if invalid — call validateReportConfig first for a user-facing error. */
export async function runCustomReportQuery(businessId: string, config: ReportConfig): Promise<ReportRow[]> {
  const { sql, params } = buildReportQuery(config, businessId);
  const { rows } = await query<ReportRow>(sql, params);
  return rows;
}

export interface DateRangeFilters {
  dateFrom?: string;
  dateTo?: string;
}

/** Raw (unaggregated) rows from a standard report's backing view, for its table display. Null-view reports (P&L, Balance Sheet) use their own dedicated functions instead. */
export async function runStandardReportRows(
  key: string,
  businessId: string,
  filters: DateRangeFilters = {},
): Promise<Record<string, unknown>[]> {
  const def = STANDARD_REPORTS.find((r) => r.key === key);
  if (!def || !def.view) throw new Error(`no_table_view_for_report: ${key}`);
  const view = REPORT_VIEWS[def.view]!;

  const params: unknown[] = [businessId];
  const where = ["business_id = $1"];
  if (view.dateColumn && filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(`${view.dateColumn} >= $${params.length}`);
  }
  if (view.dateColumn && filters.dateTo) {
    params.push(filters.dateTo);
    where.push(`${view.dateColumn} <= $${params.length}`);
  }
  const order = view.dateColumn ? `ORDER BY ${view.dateColumn} DESC` : "";
  const { rows } = await query(
    `SELECT * FROM ${def.view} WHERE ${where.join(" AND ")} ${order} LIMIT 1000`,
    params,
  );
  return rows;
}

interface LedgerAccountTotal extends Record<string, unknown> {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  debit: string;
  credit: string;
}

async function ledgerAccountTotals(
  businessId: string,
  accountTypes: string[],
  dateTo?: string,
  dateFrom?: string,
): Promise<LedgerAccountTotal[]> {
  const params: unknown[] = [businessId, accountTypes];
  const where = ["business_id = $1", "account_type::text = ANY($2::text[])"];
  if (dateFrom) {
    params.push(dateFrom);
    where.push(`entry_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`entry_date <= $${params.length}`);
  }
  const { rows } = await query<LedgerAccountTotal>(
    `SELECT account_id, account_code, account_name, account_type,
            sum(debit) AS debit, sum(credit) AS credit
       FROM v_ledger_by_account
      WHERE ${where.join(" AND ")}
      GROUP BY account_id, account_code, account_name, account_type
      ORDER BY account_code`,
    params,
  );
  return rows;
}

export interface PnlLine {
  accountCode: string;
  accountName: string;
  amount: number;
}

export interface ProfitAndLoss {
  revenue: PnlLine[];
  expenses: PnlLine[];
  totalRevenue: number;
  totalExpenses: number;
  netIncome: number;
}

/** P&L for a date range, traced directly from the Phase 7 ledger (v_ledger_by_account, revenue/expense accounts only). */
export async function getProfitAndLoss(
  businessId: string,
  filters: DateRangeFilters = {},
): Promise<ProfitAndLoss> {
  const rows = await ledgerAccountTotals(businessId, ["revenue", "expense"], filters.dateTo, filters.dateFrom);
  const revenue: PnlLine[] = [];
  const expenses: PnlLine[] = [];
  for (const r of rows) {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    if (r.account_type === "revenue") {
      revenue.push({ accountCode: r.account_code, accountName: r.account_name, amount: credit - debit });
    } else {
      expenses.push({ accountCode: r.account_code, accountName: r.account_name, amount: debit - credit });
    }
  }
  const totalRevenue = revenue.reduce((s, l) => s + l.amount, 0);
  const totalExpenses = expenses.reduce((s, l) => s + l.amount, 0);
  return { revenue, expenses, totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses };
}

export interface BalanceSheet {
  assets: PnlLine[];
  liabilities: PnlLine[];
  equity: PnlLine[];
  /** cumulative net income to date, folded into equity so the sheet balances without a period-close step. */
  retainedEarnings: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanced: boolean;
}

/**
 * Balance Sheet as of a date, traced directly from the ledger. There's no
 * period-closing step in this system (Phase 7 never transfers revenue/
 * expense into an equity account), so retained earnings is computed here as
 * all-time net income up to asOfDate and folded into equity — otherwise
 * assets would never equal liabilities + equity. This always balances by
 * construction: every posted entry balances (ledger.ts), so trial balance
 * across ALL accounts sums to zero, i.e. assets - (liabilities + equity +
 * (revenue - expenses)) = 0 identically.
 */
export async function getBalanceSheet(businessId: string, asOfDate?: string): Promise<BalanceSheet> {
  const [balanceRows, incomeRows] = await Promise.all([
    ledgerAccountTotals(businessId, ["asset", "liability", "equity"], asOfDate),
    ledgerAccountTotals(businessId, ["revenue", "expense"], asOfDate),
  ]);

  const assets: PnlLine[] = [];
  const liabilities: PnlLine[] = [];
  const equity: PnlLine[] = [];
  for (const r of balanceRows) {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    if (r.account_type === "asset") assets.push({ accountCode: r.account_code, accountName: r.account_name, amount: debit - credit });
    else if (r.account_type === "liability") liabilities.push({ accountCode: r.account_code, accountName: r.account_name, amount: credit - debit });
    else equity.push({ accountCode: r.account_code, accountName: r.account_name, amount: credit - debit });
  }

  let retainedEarnings = 0;
  for (const r of incomeRows) {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    retainedEarnings += r.account_type === "revenue" ? credit - debit : -(debit - credit);
  }

  const totalAssets = assets.reduce((s, l) => s + l.amount, 0);
  const totalLiabilities = liabilities.reduce((s, l) => s + l.amount, 0);
  const totalEquity = equity.reduce((s, l) => s + l.amount, 0) + retainedEarnings;

  return {
    assets,
    liabilities,
    equity,
    retainedEarnings,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

// ---------------------------------------------------------------------------
// Cash flow (direct method, by posting source)
// ---------------------------------------------------------------------------

/** "Cash and cash equivalents" for this statement: the two accounts the system itself auto-posts cash movements to. A business's own plain "bank" account (template code 1110) isn't included — nothing auto-posts to it today, so there's nothing to reconcile it against yet. */
const CASH_EQUIVALENT_CODES = [WELL_KNOWN_CODES.cash, WELL_KNOWN_CODES.bankClearing];

const SOURCE_TYPE_LABELS: Record<string, string> = {
  order: "دریافت از سفارش‌ها",
  purchase: "پرداخت بابت خرید",
  waste: "ضایعات",
  stock_count: "تعدیل شمارش موجودی",
  customer_return: "بازپرداخت به مشتری",
  manual: "اسناد دستی",
  expense: "هزینه‌های عملیاتی",
};

export interface CashFlowLine {
  sourceType: string;
  label: string;
  amount: number;
}

export interface CashFlowStatement {
  openingCash: number;
  closingCash: number;
  netChange: number;
  lines: CashFlowLine[];
}

async function cashEquivalentAccountIds(businessId: string): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = ANY($2::text[])`,
    [businessId, CASH_EQUIVALENT_CODES],
  );
  return rows.map((r) => r.id);
}

async function cashBalanceAsOf(
  businessId: string,
  cashAccountIds: string[],
  asOfDate?: string,
): Promise<number> {
  const params: unknown[] = [businessId, cashAccountIds];
  let dateClause = "";
  if (asOfDate) {
    params.push(asOfDate);
    dateClause = `AND je.entry_date <= $${params.length}`;
  }
  const { rows } = await query<{ debit: string; credit: string }>(
    `SELECT COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.business_id = $1 AND jl.account_id = ANY($2::uuid[]) ${dateClause}`,
    params,
  );
  return Number(rows[0].debit) - Number(rows[0].credit);
}

/**
 * Cash flow for a date range, direct method: every cash/bank-clearing
 * movement, grouped by the kind of event that posted it (an order payment, a
 * purchase, a manual entry, …) via journal_entries.source_type — the same
 * categorisation the auto-posting paths already stamp on every entry, so
 * this needs no new bookkeeping to be meaningful.
 */
export async function getCashFlow(
  businessId: string,
  filters: DateRangeFilters = {},
): Promise<CashFlowStatement> {
  const cashAccountIds = await cashEquivalentAccountIds(businessId);
  if (cashAccountIds.length === 0) {
    return { openingCash: 0, closingCash: 0, netChange: 0, lines: [] };
  }

  const params: unknown[] = [businessId, cashAccountIds];
  const where = ["je.business_id = $1", "jl.account_id = ANY($2::uuid[])"];
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(`je.entry_date >= $${params.length}`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    where.push(`je.entry_date <= $${params.length}`);
  }

  const [openingCash, closingCash, lineRows] = await Promise.all([
    filters.dateFrom
      ? cashBalanceAsOf(businessId, cashAccountIds, addDays(filters.dateFrom, -1))
      : Promise.resolve(0),
    cashBalanceAsOf(businessId, cashAccountIds, filters.dateTo),
    query<{ source_type: string | null; debit: string; credit: string }>(
      `SELECT je.source_type, SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE ${where.join(" AND ")}
        GROUP BY je.source_type`,
      params,
    ),
  ]);

  const lines: CashFlowLine[] = lineRows.rows
    .map((r) => {
      const sourceType = r.source_type ?? "manual";
      return {
        sourceType,
        label: SOURCE_TYPE_LABELS[sourceType] ?? sourceType,
        amount: Number(r.debit) - Number(r.credit),
      };
    })
    .sort((a, b) => b.amount - a.amount);

  return { openingCash, closingCash, netChange: closingCash - openingCash, lines };
}

// ---------------------------------------------------------------------------
// Period comparison — "vs previous period", same shape as the statement itself
// ---------------------------------------------------------------------------

export interface Comparison<T> {
  current: T;
  /** null when the range is open-ended (no dateFrom) — there's no length to mirror for a previous period. */
  previous: T | null;
}

export async function getProfitAndLossComparison(
  businessId: string,
  filters: DateRangeFilters,
): Promise<Comparison<ProfitAndLoss>> {
  const current = await getProfitAndLoss(businessId, filters);
  if (!filters.dateFrom || !filters.dateTo) return { current, previous: null };
  const previous = await getProfitAndLoss(businessId, previousPeriodRange(filters.dateFrom, filters.dateTo));
  return { current, previous };
}

export async function getCashFlowComparison(
  businessId: string,
  filters: DateRangeFilters,
): Promise<Comparison<CashFlowStatement>> {
  const current = await getCashFlow(businessId, filters);
  if (!filters.dateFrom || !filters.dateTo) return { current, previous: null };
  const previous = await getCashFlow(businessId, previousPeriodRange(filters.dateFrom, filters.dateTo));
  return { current, previous };
}

/**
 * Balance Sheet comparison: a snapshot has no "length" to mirror, so instead
 * of guessing one, the caller supplies the earlier as-of date directly (e.g.
 * "same day last month", or a fiscal period's start).
 */
export async function getBalanceSheetComparison(
  businessId: string,
  asOfDate: string | undefined,
  previousAsOfDate: string | undefined,
): Promise<Comparison<BalanceSheet>> {
  const current = await getBalanceSheet(businessId, asOfDate);
  if (!previousAsOfDate) return { current, previous: null };
  const previous = await getBalanceSheet(businessId, previousAsOfDate);
  return { current, previous };
}

// ---------------------------------------------------------------------------
// Drill-down — the journal entries behind one account's figure in a statement
// ---------------------------------------------------------------------------

export interface DrillDownLine {
  entryId: string;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  debit: number;
  credit: number;
}

/** Every journal line posted to `accountCode` in the given range, newest first — what a statement figure is made of. */
export async function getAccountDrillDown(
  businessId: string,
  accountCode: string,
  filters: DateRangeFilters = {},
): Promise<DrillDownLine[]> {
  const params: unknown[] = [businessId, accountCode];
  const where = ["je.business_id = $1", "a.code = $2"];
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(`je.entry_date >= $${params.length}`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    where.push(`je.entry_date <= $${params.length}`);
  }
  const { rows } = await query<{
    entry_id: string;
    entry_date: string;
    memo: string | null;
    source_type: string | null;
    debit: string;
    credit: string;
  }>(
    `SELECT je.id AS entry_id, je.entry_date::text AS entry_date, je.memo, je.source_type, jl.debit, jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE ${where.join(" AND ")}
      ORDER BY je.entry_date DESC, je.posted_at DESC
      LIMIT 500`,
    params,
  );
  return rows.map((r) => ({
    entryId: r.entry_id,
    entryDate: r.entry_date,
    memo: r.memo,
    sourceType: r.source_type,
    debit: Number(r.debit),
    credit: Number(r.credit),
  }));
}

interface SavedReportRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  created_by: string | null;
  name: string;
  config: ReportConfig;
  is_standard: boolean;
  standard_key: string | null;
  created_at: string;
  updated_at: string;
}

export async function listSavedReports(businessId: string): Promise<SavedReportRow[]> {
  const { rows } = await query<SavedReportRow>(
    "SELECT * FROM saved_reports WHERE business_id = $1 ORDER BY is_standard DESC, created_at",
    [businessId],
  );
  return rows;
}

export async function getSavedReport(businessId: string, id: string): Promise<SavedReportRow | null> {
  const { rows } = await query<SavedReportRow>(
    "SELECT * FROM saved_reports WHERE id = $1 AND business_id = $2",
    [id, businessId],
  );
  return rows[0] ?? null;
}

export async function createSavedReport(
  businessId: string,
  createdBy: string | null,
  name: string,
  config: ReportConfig,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO saved_reports (business_id, created_by, name, config) VALUES ($1, $2, $3, $4) RETURNING id`,
    [businessId, createdBy, name, JSON.stringify(config)],
  );
  return rows[0].id;
}

export async function updateSavedReport(
  businessId: string,
  id: string,
  patch: { name?: string; config?: ReportConfig },
): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [id, businessId];
  if (patch.name !== undefined) {
    values.push(patch.name);
    fields.push(`name = $${values.length}`);
  }
  if (patch.config !== undefined) {
    values.push(JSON.stringify(patch.config));
    fields.push(`config = $${values.length}`);
  }
  if (fields.length === 0) return false;
  fields.push("updated_at = now()");
  const { rowCount } = await query(
    `UPDATE saved_reports SET ${fields.join(", ")} WHERE id = $1 AND business_id = $2 AND is_standard = false`,
    values,
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteSavedReport(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    "DELETE FROM saved_reports WHERE id = $1 AND business_id = $2 AND is_standard = false",
    [id, businessId],
  );
  return (rowCount ?? 0) > 0;
}

/** Idempotently materializes the pre-built report library as saved_reports rows for a business, so they can be pinned to a dashboard like any custom report. Safe to call repeatedly (upsert on standard_key). */
export async function ensureStandardSavedReports(businessId: string): Promise<Map<string, string>> {
  const withCharts = STANDARD_REPORTS.filter((r) => r.defaultChart);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const report of withCharts) {
      await client.query(
        `INSERT INTO saved_reports (business_id, name, config, is_standard, standard_key)
         VALUES ($1, $2, $3, true, $4)
         ON CONFLICT (business_id, standard_key) WHERE standard_key IS NOT NULL
         DO UPDATE SET config = EXCLUDED.config, name = EXCLUDED.name`,
        [businessId, report.label, JSON.stringify(report.defaultChart!.config), report.key],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  const { rows } = await query<{ standard_key: string; id: string }>(
    "SELECT standard_key, id FROM saved_reports WHERE business_id = $1 AND standard_key IS NOT NULL",
    [businessId],
  );
  return new Map(rows.map((r) => [r.standard_key, r.id]));
}

export function standardChartType(key: string): ChartType | null {
  return STANDARD_REPORTS.find((r) => r.key === key)?.defaultChart?.chartType ?? null;
}

export interface DashboardWidgetRow extends Record<string, unknown> {
  id: string;
  saved_report_id: string;
  chart_type: ChartType;
  title: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  report_name: string;
  report_config: ReportConfig;
  standard_key: string | null;
}

/** A user's personal widget layout, or (if they have none yet) their role's default layout — seeded once for the Owner (see Phase 8 doc, "Dashboard defaults"). */
export async function getDashboardWidgets(
  businessId: string,
  userId: string,
  role: Role,
): Promise<{ scope: "personal" | "role-default"; widgets: DashboardWidgetRow[] }> {
  const personal = await queryWidgets(businessId, "user_id = $2", [businessId, userId]);
  if (personal.length > 0) return { scope: "personal", widgets: personal };
  let roleDefault = await queryWidgets(businessId, "role = $2", [businessId, role]);
  if (roleDefault.length === 0 && role === "owner") {
    await seedOwnerDashboardDefaults(businessId);
    roleDefault = await queryWidgets(businessId, "role = $2", [businessId, role]);
  }
  return { scope: "role-default", widgets: roleDefault };
}

/**
 * The Owner's day-to-day picture on first login after this phase ships:
 * today's revenue trend, cash/card reconciliation, what's selling, and who's
 * closing sales — the four things worth a glance without opening a report.
 * Seeded once (lazily, on first dashboard view); the Owner can then
 * rearrange or replace freely, same as any personal layout.
 */
async function seedOwnerDashboardDefaults(businessId: string): Promise<void> {
  const ids = await ensureStandardSavedReports(businessId);
  const defaults: { key: string; chartType: ChartType; x: number; y: number; w: number; h: number }[] = [
    { key: "daily_sales_summary", chartType: "bar", x: 0, y: 0, w: 6, h: 3 },
    { key: "shift_reconciliation", chartType: "bar", x: 6, y: 0, w: 6, h: 3 },
    { key: "top_selling_items", chartType: "pie", x: 0, y: 3, w: 6, h: 3 },
    { key: "staff_performance", chartType: "bar", x: 6, y: 3, w: 6, h: 3 },
  ];
  await saveDashboardWidgets(
    businessId,
    { role: "owner" },
    defaults
      .filter((d) => ids.has(d.key))
      .map((d) => ({ savedReportId: ids.get(d.key)!, chartType: d.chartType, x: d.x, y: d.y, w: d.w, h: d.h })),
  );
}

async function queryWidgets(businessId: string, extraWhere: string, params: unknown[]): Promise<DashboardWidgetRow[]> {
  const { rows } = await query<DashboardWidgetRow>(
    `SELECT dw.id, dw.saved_report_id, dw.chart_type, dw.title, dw.x, dw.y, dw.w, dw.h,
            sr.name AS report_name, sr.config AS report_config, sr.standard_key
       FROM dashboard_widgets dw JOIN saved_reports sr ON sr.id = dw.saved_report_id
      WHERE dw.business_id = $1 AND ${extraWhere}
      ORDER BY dw.y, dw.x`,
    params,
  );
  return rows;
}

export interface WidgetInput {
  savedReportId: string;
  chartType: ChartType;
  title?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Replaces a scope's whole widget layout in one transaction (drag-resize saves send the full grid). */
export async function saveDashboardWidgets(
  businessId: string,
  scope: { userId: string } | { role: Role },
  widgets: WidgetInput[],
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if ("userId" in scope) {
      await client.query("DELETE FROM dashboard_widgets WHERE business_id = $1 AND user_id = $2", [
        businessId,
        scope.userId,
      ]);
    } else {
      await client.query("DELETE FROM dashboard_widgets WHERE business_id = $1 AND role = $2", [
        businessId,
        scope.role,
      ]);
    }
    for (const widget of widgets) {
      await client.query(
        `INSERT INTO dashboard_widgets (business_id, user_id, role, saved_report_id, chart_type, title, x, y, w, h)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          businessId,
          "userId" in scope ? scope.userId : null,
          "userId" in scope ? null : scope.role,
          widget.savedReportId,
          widget.chartType,
          widget.title ?? null,
          widget.x,
          widget.y,
          widget.w,
          widget.h,
        ],
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

/** validateReportConfig re-exported for API routes that need it alongside the DB helpers above. */
export { validateReportConfig };

// ---------------------------------------------------------------------------
// Phase 14 — consolidated reporting across a business's own branches
// ---------------------------------------------------------------------------
//
// Distinct from the Phase 9 cross-*server* rollup (rollup_daily_summary,
// populated by a remote server's HTTP push): this is one business's own
// branches, all in this same database, queried directly off the Phase 8
// reporting views — the same views every per-branch report already reads, so
// a branch's numbers here can never disagree with its own reports.

export interface BranchReportRow {
  locationId: string;
  locationName: string;
  isActive: boolean;
  orderCount: number;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  cogs: number;
  wasteCost: number;
}

export interface BusinessOverview {
  from: string | null;
  to: string | null;
  branches: BranchReportRow[];
  /** Sum of every branch above — computed independently, not by adding branches client-side. */
  consolidated: Omit<BranchReportRow, "locationId" | "locationName" | "isActive">;
}

function emptyTotals() {
  return { orderCount: 0, subtotal: 0, discount: 0, tax: 0, total: 0, cogs: 0, wasteCost: 0 };
}

/**
 * Per-branch and business-wide totals for a date range, both derived from the
 * same underlying views so they are guaranteed to reconcile — the exit
 * criterion isn't "we hope these two numbers agree", it's that there is only
 * one query path they could have come from.
 */
export async function getBusinessOverview(
  businessId: string,
  filters: DateRangeFilters = {},
): Promise<BusinessOverview> {
  const { dateFrom, dateTo } = filters;

  const [locationsResult, salesResult, cogsResult, wasteResult, consolidatedSales, consolidatedCogs, consolidatedWaste] =
    await Promise.all([
      query<{ id: string; name: string; is_active: boolean }>(
        "SELECT id, name, is_active FROM locations WHERE business_id = $1 ORDER BY created_at",
        [businessId],
      ),
      query<{ location_id: string; order_count: string; subtotal: string; discount: string; tax: string; total: string }>(
        `SELECT location_id, sum(order_count) AS order_count, sum(subtotal) AS subtotal,
                sum(discount) AS discount, sum(tax) AS tax, sum(total) AS total
           FROM v_sales_by_day
          WHERE business_id = $1
            AND ($2::date IS NULL OR sale_date >= $2) AND ($3::date IS NULL OR sale_date <= $3)
          GROUP BY location_id`,
        [businessId, dateFrom ?? null, dateTo ?? null],
      ),
      query<{ location_id: string; cogs: string }>(
        `SELECT location_id, sum(debit) - sum(credit) AS cogs
           FROM v_ledger_by_account
          WHERE business_id = $1 AND account_code = $4
            AND ($2::date IS NULL OR entry_date >= $2) AND ($3::date IS NULL OR entry_date <= $3)
          GROUP BY location_id`,
        [businessId, dateFrom ?? null, dateTo ?? null, WELL_KNOWN_CODES.cogs],
      ),
      query<{ location_id: string; cost: string }>(
        `SELECT location_id, sum(cost) AS cost
           FROM v_waste_summary
          WHERE business_id = $1
            AND ($2::date IS NULL OR waste_date >= $2) AND ($3::date IS NULL OR waste_date <= $3)
          GROUP BY location_id`,
        [businessId, dateFrom ?? null, dateTo ?? null],
      ),
      query<{ order_count: string; subtotal: string; discount: string; tax: string; total: string }>(
        `SELECT sum(order_count) AS order_count, sum(subtotal) AS subtotal,
                sum(discount) AS discount, sum(tax) AS tax, sum(total) AS total
           FROM v_sales_by_day
          WHERE business_id = $1
            AND ($2::date IS NULL OR sale_date >= $2) AND ($3::date IS NULL OR sale_date <= $3)`,
        [businessId, dateFrom ?? null, dateTo ?? null],
      ),
      query<{ cogs: string }>(
        `SELECT sum(debit) - sum(credit) AS cogs
           FROM v_ledger_by_account
          WHERE business_id = $1 AND account_code = $4
            AND ($2::date IS NULL OR entry_date >= $2) AND ($3::date IS NULL OR entry_date <= $3)`,
        [businessId, dateFrom ?? null, dateTo ?? null, WELL_KNOWN_CODES.cogs],
      ),
      query<{ cost: string }>(
        `SELECT sum(cost) AS cost
           FROM v_waste_summary
          WHERE business_id = $1
            AND ($2::date IS NULL OR waste_date >= $2) AND ($3::date IS NULL OR waste_date <= $3)`,
        [businessId, dateFrom ?? null, dateTo ?? null],
      ),
    ]);

  const salesByLocation = new Map(salesResult.rows.map((r) => [r.location_id, r]));
  const cogsByLocation = new Map(cogsResult.rows.map((r) => [r.location_id, r]));
  const wasteByLocation = new Map(wasteResult.rows.map((r) => [r.location_id, r]));

  const branches: BranchReportRow[] = locationsResult.rows.map((loc) => {
    const sales = salesByLocation.get(loc.id);
    const cogs = cogsByLocation.get(loc.id);
    const waste = wasteByLocation.get(loc.id);
    return {
      locationId: loc.id,
      locationName: loc.name,
      isActive: loc.is_active,
      orderCount: Number(sales?.order_count ?? 0),
      subtotal: Number(sales?.subtotal ?? 0),
      discount: Number(sales?.discount ?? 0),
      tax: Number(sales?.tax ?? 0),
      total: Number(sales?.total ?? 0),
      cogs: Number(cogs?.cogs ?? 0),
      wasteCost: Number(waste?.cost ?? 0),
    };
  });

  const sales = consolidatedSales.rows[0];
  const cogs = consolidatedCogs.rows[0];
  const waste = consolidatedWaste.rows[0];
  const consolidated = sales
    ? {
        orderCount: Number(sales.order_count ?? 0),
        subtotal: Number(sales.subtotal ?? 0),
        discount: Number(sales.discount ?? 0),
        tax: Number(sales.tax ?? 0),
        total: Number(sales.total ?? 0),
        cogs: Number(cogs?.cogs ?? 0),
        wasteCost: Number(waste?.cost ?? 0),
      }
    : emptyTotals();

  return { from: dateFrom ?? null, to: dateTo ?? null, branches, consolidated };
}
