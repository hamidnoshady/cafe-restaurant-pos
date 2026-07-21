/**
 * Report builder — pure logic. Defines the whitelist of reporting views a
 * custom (or standard) report is allowed to query, and turns a validated
 * {view, metric, dimension, filters} config into a parameterized SQL
 * query. No DB access here (see reports-service.ts for that) — this file
 * is what's unit tested, the same split as ledger.ts/ledger-service.ts.
 *
 * SAFETY: a report config only ever supplies *keys* (view/metric/dimension/
 * filter names). Every key is resolved against REPORT_VIEWS — a whitelist
 * this file owns — before it touches SQL; an unknown key is rejected, never
 * interpolated. Filter *values* are always bound as query parameters. This
 * is what makes "custom reports only ever query views, never raw
 * transactional tables" true by construction, not by convention.
 */
import { WELL_KNOWN_CODES } from "./coa-template";

export type Aggregation = "sum" | "avg" | "count";
export type DateGranularity = "day" | "week" | "month";

export interface MetricDef {
  key: string;
  label: string;
  /** null = COUNT(*) (row count); ignores the aggregation column. */
  column: string | null;
  aggregations: Aggregation[];
}

export interface DimensionDef {
  key: string;
  label: string;
  /** date-bucket dimension: truncates the view's dateColumn to this granularity. */
  dateTrunc?: DateGranularity;
  /** entity dimension: columns to GROUP BY; the last one is the display label. */
  columns?: string[];
}

export interface FilterDef {
  key: string;
  label: string;
  column: string;
}

export interface ReportViewDef {
  label: string;
  /** the view's date column (used by date-bucket dimensions and date-range filters), if any. */
  dateColumn: string | null;
  dimensions: DimensionDef[];
  metrics: MetricDef[];
  filters?: FilterDef[];
}

/**
 * Every reporting view from migrations/0008_reporting.sql. Keys here (view
 * names) are the only strings ever interpolated into `FROM <view>` — since
 * this whole object is a fixed compile-time constant, that's equivalent to
 * a hard-coded allowlist, not user input.
 */
export const REPORT_VIEWS: Record<string, ReportViewDef> = {
  v_sales_by_day: {
    label: "فروش روزانه",
    dateColumn: "sale_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
    ],
    metrics: [
      { key: "total", label: "جمع فروش", column: "total", aggregations: ["sum", "avg"] },
      { key: "subtotal", label: "جمع جزء", column: "subtotal", aggregations: ["sum", "avg"] },
      { key: "discount", label: "تخفیف", column: "discount", aggregations: ["sum", "avg"] },
      { key: "tax", label: "مالیات", column: "tax", aggregations: ["sum", "avg"] },
      { key: "order_count", label: "تعداد سفارش", column: "order_count", aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد روز", column: null, aggregations: ["count"] },
    ],
  },
  v_menu_item_performance: {
    label: "عملکرد اقلام منو",
    dateColumn: "sale_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "item", label: "قلم منو", columns: ["menu_item_id", "item_name"] },
      { key: "category", label: "دسته", columns: ["category_id", "category_name"] },
    ],
    metrics: [
      { key: "quantity", label: "تعداد فروش", column: "quantity", aggregations: ["sum", "avg"] },
      { key: "revenue", label: "درآمد", column: "revenue", aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد ردیف", column: null, aggregations: ["count"] },
    ],
    filters: [{ key: "category", label: "دسته", column: "category_id" }],
  },
  v_inventory_valuation: {
    label: "ارزش‌گذاری موجودی",
    dateColumn: null,
    dimensions: [{ key: "item", label: "کالا", columns: ["inventory_item_id", "item_name"] }],
    metrics: [
      { key: "stock_qty", label: "موجودی", column: "stock_qty", aggregations: ["sum", "avg"] },
      { key: "valuation", label: "ارزش موجودی", column: "valuation", aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد کالا", column: null, aggregations: ["count"] },
    ],
  },
  v_ledger_by_account: {
    label: "دفتر حساب‌ها",
    dateColumn: "entry_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "account", label: "حساب", columns: ["account_id", "account_code", "account_name"] },
      { key: "account_type", label: "نوع حساب", columns: ["account_type"] },
    ],
    metrics: [
      { key: "debit", label: "بدهکار", column: "debit", aggregations: ["sum", "avg"] },
      { key: "credit", label: "بستانکار", column: "credit", aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد سطر", column: null, aggregations: ["count"] },
    ],
    filters: [
      { key: "account_code", label: "کد حساب", column: "account_code" },
      { key: "account_type", label: "نوع حساب", column: "account_type" },
    ],
  },
  v_shift_reconciliation: {
    label: "تطبیق شیفت",
    dateColumn: "business_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "staff", label: "صندوق‌دار", columns: ["closed_by", "cashier_name"] },
    ],
    metrics: [
      { key: "gross_total", label: "جمع فروش", column: "gross_total", aggregations: ["sum", "avg"] },
      { key: "cash_total", label: "نقدی", column: "cash_total", aggregations: ["sum", "avg"] },
      { key: "card_total", label: "کارت‌خوان", column: "card_total", aggregations: ["sum", "avg"] },
      { key: "online_total", label: "آنلاین", column: "online_total", aggregations: ["sum", "avg"] },
      { key: "credit_total", label: "نسیه", column: "credit_total", aggregations: ["sum", "avg"] },
      { key: "order_count", label: "تعداد سفارش", column: "order_count", aggregations: ["sum", "avg"] },
    ],
  },
  v_table_turnover: {
    label: "چرخش میزها",
    dateColumn: "closed_at",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "table", label: "میز", columns: ["table_id", "table_name"] },
    ],
    metrics: [
      { key: "duration_minutes", label: "مدت اشغال (دقیقه)", column: "duration_minutes", aggregations: ["sum", "avg"] },
      { key: "revenue", label: "درآمد", column: "revenue", aggregations: ["sum", "avg"] },
      { key: "party_size", label: "تعداد مهمان", column: "party_size", aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد نشست", column: null, aggregations: ["count"] },
    ],
  },
  v_staff_performance: {
    label: "عملکرد کارکنان",
    dateColumn: "business_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "staff", label: "کارمند", columns: ["staff_id", "staff_name"] },
    ],
    metrics: [
      { key: "order_count", label: "تعداد سفارش", column: "order_count", aggregations: ["sum", "avg"] },
      { key: "revenue", label: "درآمد", column: "revenue", aggregations: ["sum", "avg"] },
      { key: "avg_ticket", label: "میانگین صورتحساب", column: "avg_ticket", aggregations: ["avg"] },
    ],
  },
  v_waste_summary: {
    label: "گزارش ضایعات",
    dateColumn: "waste_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "item", label: "کالا", columns: ["inventory_item_id", "item_name"] },
      { key: "reason", label: "دلیل ضایعات", columns: ["waste_reason"] },
    ],
    metrics: [
      { key: "quantity", label: "مقدار", column: "quantity", aggregations: ["sum", "avg"] },
      { key: "cost", label: "بهای ضایعات", column: "cost", aggregations: ["sum", "avg"] },
    ],
  },
};

export interface ReportFilters {
  /** inclusive, ISO date (YYYY-MM-DD); only applies if the view has a dateColumn */
  dateFrom?: string;
  dateTo?: string;
  /** key -> value; each key must be one of the view's declared FilterDef keys */
  equals?: Record<string, string>;
}

export interface ReportSort {
  by: "dimension" | "metric";
  dir: "asc" | "desc";
}

export interface ReportConfig {
  view: string;
  metric: string;
  aggregation: Aggregation;
  dimension: string;
  filters?: ReportFilters;
  sort?: ReportSort;
  /** max rows returned; undefined = no limit */
  limit?: number;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates a report config against the view whitelist. Empty array = valid. Persian error strings. */
export function validateReportConfig(config: ReportConfig): string[] {
  const errors: string[] = [];
  const view = REPORT_VIEWS[config.view];
  if (!view) {
    errors.push("منبع داده نامعتبر است.");
    return errors;
  }

  const metric = view.metrics.find((m) => m.key === config.metric);
  if (!metric) {
    errors.push("معیار انتخاب‌شده برای این منبع داده معتبر نیست.");
  } else if (!metric.aggregations.includes(config.aggregation)) {
    errors.push("نوع تجمیع برای این معیار پشتیبانی نمی‌شود.");
  }

  const dimension = view.dimensions.find((d) => d.key === config.dimension);
  if (!dimension) {
    errors.push("بُعد انتخاب‌شده برای این منبع داده معتبر نیست.");
  }
  if (dimension?.dateTrunc && !view.dateColumn) {
    errors.push("این منبع داده بُعد زمانی ندارد.");
  }

  if (config.filters?.dateFrom && !ISO_DATE_RE.test(config.filters.dateFrom)) {
    errors.push("تاریخ شروع نامعتبر است.");
  }
  if (config.filters?.dateTo && !ISO_DATE_RE.test(config.filters.dateTo)) {
    errors.push("تاریخ پایان نامعتبر است.");
  }
  if (config.filters?.dateFrom && config.filters?.dateTo && config.filters.dateFrom > config.filters.dateTo) {
    errors.push("تاریخ شروع نمی‌تواند بعد از تاریخ پایان باشد.");
  }
  if ((config.filters?.dateFrom || config.filters?.dateTo) && !view.dateColumn) {
    errors.push("این منبع داده قابل فیلتر بر اساس تاریخ نیست.");
  }

  if (config.filters?.equals) {
    for (const key of Object.keys(config.filters.equals)) {
      if (!view.filters?.some((f) => f.key === key)) {
        errors.push(`فیلتر «${key}» برای این منبع داده معتبر نیست.`);
      }
    }
  }

  if (config.limit !== undefined && (!Number.isInteger(config.limit) || config.limit <= 0)) {
    errors.push("محدودیت تعداد ردیف باید عدد صحیح مثبت باشد.");
  }

  return errors;
}

/**
 * Builds a parameterized SQL query for a validated config. Throws if the
 * config is invalid — callers should run validateReportConfig first (the
 * API route does; this is the last line of defense, not the primary check).
 * $1 is always businessId.
 */
export function buildReportQuery(
  config: ReportConfig,
  businessId: string,
): { sql: string; params: unknown[] } {
  const errors = validateReportConfig(config);
  if (errors.length > 0) {
    throw new Error(`invalid_report_config: ${errors.join(" | ")}`);
  }
  const view = REPORT_VIEWS[config.view]!;
  const metric = view.metrics.find((m) => m.key === config.metric)!;
  const dimension = view.dimensions.find((d) => d.key === config.dimension)!;

  let dimSelect: string;
  let groupBy: string;
  if (dimension.dateTrunc) {
    const expr = `date_trunc('${dimension.dateTrunc}', ${view.dateColumn})::date`;
    dimSelect = `${expr} AS dim`;
    groupBy = expr;
  } else {
    const cols = dimension.columns!;
    dimSelect = `${cols[cols.length - 1]} AS dim`;
    groupBy = cols.join(", ");
  }

  const aggExpr = config.aggregation === "count" ? "count(*)" : `${config.aggregation}(${metric.column})`;

  const params: unknown[] = [businessId];
  const where = ["business_id = $1"];
  if (view.dateColumn && config.filters?.dateFrom) {
    params.push(config.filters.dateFrom);
    where.push(`${view.dateColumn} >= $${params.length}`);
  }
  if (view.dateColumn && config.filters?.dateTo) {
    params.push(config.filters.dateTo);
    where.push(`${view.dateColumn} <= $${params.length}`);
  }
  if (config.filters?.equals) {
    for (const [key, value] of Object.entries(config.filters.equals)) {
      const filterDef = view.filters!.find((f) => f.key === key)!;
      params.push(value);
      where.push(`${filterDef.column} = $${params.length}`);
    }
  }

  const sortBy = config.sort?.by === "metric" ? "value" : "dim";
  const sortDir = config.sort?.dir === "desc" ? "DESC" : "ASC";

  let sql = `SELECT ${dimSelect}, ${aggExpr} AS value FROM ${config.view} WHERE ${where.join(" AND ")} GROUP BY ${groupBy} ORDER BY ${sortBy} ${sortDir}`;
  if (config.limit) {
    params.push(config.limit);
    sql += ` LIMIT $${params.length}`;
  }
  return { sql, params };
}

export type ChartType = "line" | "bar" | "pie" | "number";

export interface StandardReportDef {
  key: string;
  label: string;
  /** underlying view for a plain row dump (table display); pnl/balance_sheet are computed separately. */
  view: string | null;
  defaultChart: { chartType: ChartType; config: ReportConfig } | null;
}

/**
 * The pre-built report library (Phase 8 scope: "daily sales summary, shift
 * reconciliation, COGS trend, inventory valuation, top-selling items, waste
 * report, P&L, Balance Sheet, staff performance, table turnover time").
 * P&L/Balance Sheet have no single metric/dimension shape (they're
 * structured account-type rollups) — reports-service.ts computes those
 * directly from v_ledger_by_account instead of through buildReportQuery.
 */
export const STANDARD_REPORTS: StandardReportDef[] = [
  {
    key: "daily_sales_summary",
    label: "خلاصه فروش روزانه",
    view: "v_sales_by_day",
    defaultChart: {
      chartType: "bar",
      config: { view: "v_sales_by_day", metric: "total", aggregation: "sum", dimension: "day" },
    },
  },
  {
    key: "shift_reconciliation",
    label: "تطبیق شیفت",
    view: "v_shift_reconciliation",
    defaultChart: {
      chartType: "bar",
      config: { view: "v_shift_reconciliation", metric: "gross_total", aggregation: "sum", dimension: "day" },
    },
  },
  {
    key: "cogs_trend",
    label: "روند بهای تمام‌شده کالا (COGS)",
    view: "v_ledger_by_account",
    defaultChart: {
      chartType: "line",
      config: {
        view: "v_ledger_by_account",
        metric: "debit",
        aggregation: "sum",
        dimension: "day",
        filters: { equals: { account_code: WELL_KNOWN_CODES.cogs } },
      },
    },
  },
  {
    key: "inventory_valuation",
    label: "ارزش‌گذاری موجودی",
    view: "v_inventory_valuation",
    defaultChart: {
      chartType: "bar",
      config: {
        view: "v_inventory_valuation",
        metric: "valuation",
        aggregation: "sum",
        dimension: "item",
        sort: { by: "metric", dir: "desc" },
        limit: 10,
      },
    },
  },
  {
    key: "top_selling_items",
    label: "پرفروش‌ترین اقلام",
    view: "v_menu_item_performance",
    defaultChart: {
      chartType: "bar",
      config: {
        view: "v_menu_item_performance",
        metric: "quantity",
        aggregation: "sum",
        dimension: "item",
        sort: { by: "metric", dir: "desc" },
        limit: 10,
      },
    },
  },
  {
    key: "waste_report",
    label: "گزارش ضایعات",
    view: "v_waste_summary",
    defaultChart: {
      chartType: "pie",
      config: { view: "v_waste_summary", metric: "cost", aggregation: "sum", dimension: "reason" },
    },
  },
  { key: "profit_and_loss", label: "صورت سود و زیان", view: null, defaultChart: null },
  { key: "balance_sheet", label: "ترازنامه", view: null, defaultChart: null },
  {
    key: "staff_performance",
    label: "عملکرد کارکنان",
    view: "v_staff_performance",
    defaultChart: {
      chartType: "bar",
      config: {
        view: "v_staff_performance",
        metric: "revenue",
        aggregation: "sum",
        dimension: "staff",
        sort: { by: "metric", dir: "desc" },
      },
    },
  },
  {
    key: "table_turnover",
    label: "چرخش میزها",
    view: "v_table_turnover",
    defaultChart: {
      chartType: "bar",
      config: { view: "v_table_turnover", metric: "duration_minutes", aggregation: "avg", dimension: "table" },
    },
  },
];
