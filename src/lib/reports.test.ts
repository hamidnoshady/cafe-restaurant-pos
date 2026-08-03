import { describe, expect, it } from "vitest";
import {
  buildReportQuery,
  previousPeriodRange,
  REPORT_VIEWS,
  STANDARD_REPORTS,
  validateReportConfig,
  type ReportConfig,
} from "./reports";

const BIZ = "biz-1";

describe("REPORT_VIEWS whitelist", () => {
  it("every dimension/metric/filter key is unique within its view", () => {
    for (const [name, view] of Object.entries(REPORT_VIEWS)) {
      const dimKeys = view.dimensions.map((d) => d.key);
      expect(new Set(dimKeys).size, `${name} dimensions`).toBe(dimKeys.length);
      const metricKeys = view.metrics.map((m) => m.key);
      expect(new Set(metricKeys).size, `${name} metrics`).toBe(metricKeys.length);
      if (view.filters) {
        const filterKeys = view.filters.map((f) => f.key);
        expect(new Set(filterKeys).size, `${name} filters`).toBe(filterKeys.length);
      }
    }
  });

  it("every date-trunc dimension belongs to a view with a dateColumn", () => {
    for (const view of Object.values(REPORT_VIEWS)) {
      if (view.dimensions.some((d) => d.dateTrunc)) {
        expect(view.dateColumn).not.toBeNull();
      }
    }
  });
});

describe("validateReportConfig", () => {
  it("accepts a well-formed config", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
    };
    expect(validateReportConfig(config)).toEqual([]);
  });

  it("rejects an unknown view", () => {
    const config = { view: "orders", metric: "total", aggregation: "sum", dimension: "day" } as ReportConfig;
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects an unknown metric for the view", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "not_a_metric",
      aggregation: "sum",
      dimension: "day",
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects an aggregation not supported by the metric", () => {
    const config: ReportConfig = {
      view: "v_staff_performance",
      metric: "avg_ticket",
      aggregation: "sum",
      dimension: "day",
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects an unknown dimension for the view", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "item",
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects a date-range filter on a view with no date column", () => {
    const config: ReportConfig = {
      view: "v_inventory_valuation",
      metric: "valuation",
      aggregation: "sum",
      dimension: "item",
      filters: { dateFrom: "2026-01-01" },
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects dateFrom after dateTo", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
      filters: { dateFrom: "2026-02-01", dateTo: "2026-01-01" },
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects a malformed date string", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
      filters: { dateFrom: "01/01/2026" },
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects an equals-filter key not declared by the view", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
      filters: { equals: { not_a_filter: "x" } },
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("accepts a declared equals-filter key", () => {
    const config: ReportConfig = {
      view: "v_ledger_by_account",
      metric: "debit",
      aggregation: "sum",
      dimension: "day",
      filters: { equals: { account_code: "5100" } },
    };
    expect(validateReportConfig(config)).toEqual([]);
  });

  it("rejects a non-positive limit", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
      limit: 0,
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });
});

describe("buildReportQuery", () => {
  it("throws for an invalid config instead of building SQL", () => {
    const config = { view: "nope", metric: "x", aggregation: "sum", dimension: "y" } as ReportConfig;
    expect(() => buildReportQuery(config, BIZ)).toThrow();
  });

  it("builds a day-bucketed sum query with businessId bound as $1", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
    };
    const { sql, params } = buildReportQuery(config, BIZ);
    expect(params[0]).toBe(BIZ);
    expect(sql).toContain("FROM v_sales_by_day");
    expect(sql).toContain("business_id = $1");
    expect(sql).toContain("date_trunc('day', sale_date)::date AS dim");
    expect(sql).toContain("sum(total) AS value");
    expect(sql).toContain("GROUP BY date_trunc('day', sale_date)::date");
  });

  it("binds a supplied location after business scope for branch-bound callers", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
      filters: { dateFrom: "2026-01-01", dateTo: "2026-01-31" },
    };
    const { sql, params } = buildReportQuery(config, BIZ, "location-1");
    expect(params).toEqual([BIZ, "location-1", "2026-01-01", "2026-01-31"]);
    expect(sql).toContain("business_id = $1");
    expect(sql).toContain("location_id = $2");
    expect(sql).toContain("sale_date >= $3");
    expect(sql).toContain("sale_date <= $4");
  });

  it("builds an entity-dimension query grouping by id + label columns", () => {
    const config: ReportConfig = {
      view: "v_menu_item_performance",
      metric: "quantity",
      aggregation: "sum",
      dimension: "item",
    };
    const { sql } = buildReportQuery(config, BIZ);
    expect(sql).toContain("item_name AS dim");
    expect(sql).toContain("GROUP BY menu_item_id, item_name");
  });

  it("uses COUNT(*) for the count aggregation and ignores the metric column", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "rows",
      aggregation: "count",
      dimension: "day",
    };
    const { sql } = buildReportQuery(config, BIZ);
    expect(sql).toContain("count(*) AS value");
  });

  it("binds date-range filters as parameters, in order, after businessId", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
      filters: { dateFrom: "2026-01-01", dateTo: "2026-01-31" },
    };
    const { sql, params } = buildReportQuery(config, BIZ);
    expect(params).toEqual([BIZ, "2026-01-01", "2026-01-31"]);
    expect(sql).toContain("sale_date >= $2");
    expect(sql).toContain("sale_date <= $3");
  });

  it("binds an equals filter by its declared column, never the raw key", () => {
    const config: ReportConfig = {
      view: "v_ledger_by_account",
      metric: "debit",
      aggregation: "sum",
      dimension: "day",
      filters: { equals: { account_code: "5100" } },
    };
    const { sql, params } = buildReportQuery(config, BIZ);
    expect(sql).toContain("account_code = $2");
    expect(params).toEqual([BIZ, "5100"]);
  });

  it("applies sort and limit", () => {
    const config: ReportConfig = {
      view: "v_menu_item_performance",
      metric: "quantity",
      aggregation: "sum",
      dimension: "item",
      sort: { by: "metric", dir: "desc" },
      limit: 10,
    };
    const { sql, params } = buildReportQuery(config, BIZ);
    expect(sql).toContain("ORDER BY value DESC");
    expect(sql).toContain("LIMIT $2");
    expect(params).toEqual([BIZ, 10]);
  });

  it("defaults to ordering by dimension ascending", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
    };
    const { sql } = buildReportQuery(config, BIZ);
    expect(sql).toContain("ORDER BY dim ASC");
  });
});

describe("STANDARD_REPORTS", () => {
  it("has 13 pre-built reports with unique keys", () => {
    expect(STANDARD_REPORTS).toHaveLength(13);
    expect(new Set(STANDARD_REPORTS.map((r) => r.key)).size).toBe(13);
  });

  it("every defaultChart config validates cleanly against REPORT_VIEWS", () => {
    for (const report of STANDARD_REPORTS) {
      if (!report.defaultChart) continue;
      expect(validateReportConfig(report.defaultChart.config), report.key).toEqual([]);
    }
  });

  it("profit_and_loss, balance_sheet and cash_flow have no generic view (computed separately)", () => {
    const pnl = STANDARD_REPORTS.find((r) => r.key === "profit_and_loss");
    const bs = STANDARD_REPORTS.find((r) => r.key === "balance_sheet");
    const cf = STANDARD_REPORTS.find((r) => r.key === "cash_flow");
    expect(pnl?.view).toBeNull();
    expect(bs?.view).toBeNull();
    expect(cf?.view).toBeNull();
  });
});

describe("previousPeriodRange", () => {
  it("shifts back by the same number of days, ending the day before dateFrom", () => {
    expect(previousPeriodRange("2025-04-01", "2025-04-30")).toEqual({
      dateFrom: "2025-03-02",
      dateTo: "2025-03-31",
    });
  });

  it("handles a single-day range", () => {
    expect(previousPeriodRange("2025-04-15", "2025-04-15")).toEqual({
      dateFrom: "2025-04-14",
      dateTo: "2025-04-14",
    });
  });

  it("crosses a year boundary correctly", () => {
    expect(previousPeriodRange("2025-01-01", "2025-01-31")).toEqual({
      dateFrom: "2024-12-01",
      dateTo: "2024-12-31",
    });
  });
});
