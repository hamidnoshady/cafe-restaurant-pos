/**
 * DB-touching reporting orchestration (not unit-tested directly, per repo
 * convention — pure logic lives in reports.ts and is what *.test.ts covers).
 */
import { query, getPool } from "./db";
import {
  buildReportQuery,
  REPORT_VIEWS,
  STANDARD_REPORTS,
  validateReportConfig,
  type ReportConfig,
  type ChartType,
} from "./reports";
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

/** A user's personal widget layout, or (if they have none yet) their role's default layout. */
export async function getDashboardWidgets(
  businessId: string,
  userId: string,
  role: Role,
): Promise<{ scope: "personal" | "role-default"; widgets: DashboardWidgetRow[] }> {
  const personal = await queryWidgets(businessId, "user_id = $2", [businessId, userId]);
  if (personal.length > 0) return { scope: "personal", widgets: personal };
  const roleDefault = await queryWidgets(businessId, "role = $2", [businessId, role]);
  return { scope: "role-default", widgets: roleDefault };
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
