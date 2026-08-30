import { describe, expect, it } from "vitest";
import {
  buildFoodCostVariance,
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

  it("only the count aggregation is offered on a column-less metric", () => {
    // count is COUNT(*); every other aggregation interpolates metric.column
    // into SQL, so pairing one with a null column would emit "null".
    for (const [name, view] of Object.entries(REPORT_VIEWS)) {
      for (const metric of view.metrics) {
        if (metric.column === null) {
          expect(metric.aggregations, `${name}.${metric.key}`).toEqual(["count"]);
        }
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

  it("reports add-on revenue at the modifier grain, filtered by group", () => {
    const config: ReportConfig = {
      view: "v_modifier_performance",
      metric: "revenue",
      aggregation: "sum",
      dimension: "modifier",
      filters: { equals: { group: "grp-1" } },
    };
    expect(validateReportConfig(config)).toEqual([]);
    const { sql, params } = buildReportQuery(config, BIZ);
    expect(sql).toContain("FROM v_modifier_performance");
    expect(sql).toContain("modifier_name AS dim");
    expect(sql).toContain("GROUP BY modifier_id, modifier_name");
    expect(sql).toContain("sum(revenue) AS value");
    expect(sql).toContain("modifier_group_id = $2");
    expect(params).toEqual([BIZ, "grp-1"]);
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

  it("counts purchases, not purchase lines, via count_distinct", () => {
    const config: ReportConfig = {
      view: "v_purchase_summary",
      metric: "purchase_count",
      aggregation: "count_distinct",
      dimension: "supplier",
    };
    expect(validateReportConfig(config)).toEqual([]);
    const { sql } = buildReportQuery(config, BIZ);
    expect(sql).toContain("count(DISTINCT purchase_id) AS value");
    expect(sql).toContain("GROUP BY supplier_id, supplier_name");
  });

  it("reports purchase spend by item, filtered to received purchases", () => {
    const config: ReportConfig = {
      view: "v_purchase_summary",
      metric: "cost",
      aggregation: "sum",
      dimension: "item",
      filters: { dateFrom: "2026-01-01", equals: { status: "received" } },
    };
    expect(validateReportConfig(config)).toEqual([]);
    const { sql, params } = buildReportQuery(config, BIZ);
    expect(sql).toContain("FROM v_purchase_summary");
    expect(sql).toContain("sum(cost) AS value");
    expect(sql).toContain("purchase_date >= $2");
    expect(sql).toContain("status = $3");
    expect(params).toEqual([BIZ, "2026-01-01", "received"]);
  });

  it("reports expense totals by expense-account category", () => {
    const config: ReportConfig = {
      view: "v_expense_summary",
      metric: "amount",
      aggregation: "sum",
      dimension: "category",
    };
    expect(validateReportConfig(config)).toEqual([]);
    const { sql } = buildReportQuery(config, BIZ);
    expect(sql).toContain("FROM v_expense_summary");
    expect(sql).toContain("account_name AS dim");
    expect(sql).toContain("GROUP BY account_id, account_code, account_name");
    expect(sql).toContain("sum(amount) AS value");
  });

  it("rejects an aggregation the metric does not offer", () => {
    const config: ReportConfig = {
      view: "v_purchase_summary",
      metric: "purchase_count",
      aggregation: "sum",
      dimension: "supplier",
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects a column-less metric under any aggregation but count", () => {
    // Guards the SQL builder: every aggregation except count interpolates
    // metric.column, so a null column would emit the literal string "null".
    const config: ReportConfig = {
      view: "v_purchase_summary",
      metric: "rows",
      aggregation: "count_distinct",
      dimension: "supplier",
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
    expect(() => buildReportQuery(config, BIZ)).toThrow(/invalid_report_config/);
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
  it("has 22 pre-built reports with unique keys", () => {
    // 18 through Phase 35, plus Phase 36's four CRM reports (acquisition,
    // retention, lifetime value, consent coverage).
    expect(STANDARD_REPORTS).toHaveLength(22);
    expect(new Set(STANDARD_REPORTS.map((r) => r.key)).size).toBe(22);
  });

  it("every non-null view is a whitelisted reporting view", () => {
    for (const report of STANDARD_REPORTS) {
      if (!report.view) continue;
      expect(REPORT_VIEWS[report.view], report.key).toBeDefined();
    }
  });

  it("every defaultChart config validates cleanly against REPORT_VIEWS", () => {
    for (const report of STANDARD_REPORTS) {
      if (!report.defaultChart) continue;
      expect(validateReportConfig(report.defaultChart.config), report.key).toEqual([]);
    }
  });

  it("profit_and_loss, balance_sheet, cash_flow and food_cost_variance have no generic view (computed separately)", () => {
    const pnl = STANDARD_REPORTS.find((r) => r.key === "profit_and_loss");
    const bs = STANDARD_REPORTS.find((r) => r.key === "balance_sheet");
    const cf = STANDARD_REPORTS.find((r) => r.key === "cash_flow");
    const fcv = STANDARD_REPORTS.find((r) => r.key === "food_cost_variance");
    expect(pnl?.view).toBeNull();
    expect(bs?.view).toBeNull();
    expect(cf?.view).toBeNull();
    expect(fcv?.view).toBeNull();
  });
});

describe("buildFoodCostVariance", () => {
  it("computes each item's food-cost % and sorts worst (highest %) first", () => {
    const result = buildFoodCostVariance(
      [
        { menuItemId: "a", menuItemName: "اسپرسو", unitsSold: 10, theoreticalCost: 100_000, revenue: 500_000 },
        { menuItemId: "b", menuItemName: "کیک شکلاتی", unitsSold: 5, theoreticalCost: 200_000, revenue: 400_000 },
      ],
      0,
      0,
    );
    expect(result.items.map((i) => i.menuItemId)).toEqual(["b", "a"]);
    expect(result.items[0].foodCostPct).toBeCloseTo(0.5);
    expect(result.items[1].foodCostPct).toBeCloseTo(0.2);
  });

  it("returns a null food-cost % for an item with no revenue, sorted last", () => {
    const result = buildFoodCostVariance(
      [
        { menuItemId: "a", menuItemName: "اسپرسو", unitsSold: 10, theoreticalCost: 100_000, revenue: 500_000 },
        { menuItemId: "b", menuItemName: "بدون فروش", unitsSold: 0, theoreticalCost: 0, revenue: 0 },
      ],
      0,
      0,
    );
    expect(result.items.map((i) => i.menuItemId)).toEqual(["a", "b"]);
    expect(result.items[1].foodCostPct).toBeNull();
  });

  it("sums theoretical cost across items and compares it against actual COGS + waste", () => {
    const result = buildFoodCostVariance(
      [
        { menuItemId: "a", menuItemName: "اسپرسو", unitsSold: 10, theoreticalCost: 100_000, revenue: 500_000 },
        { menuItemId: "b", menuItemName: "کیک شکلاتی", unitsSold: 5, theoreticalCost: 200_000, revenue: 400_000 },
      ],
      330_000,
      20_000,
    );
    expect(result.theoreticalCost).toBe(300_000);
    expect(result.actualCogs).toBe(330_000);
    expect(result.wasteCost).toBe(20_000);
    expect(result.actualTotalCost).toBe(350_000);
    // spent 50,000 more than the recipes predict
    expect(result.variance).toBe(50_000);
    expect(result.variancePct).toBeCloseTo(50_000 / 300_000);
    // of that 50,000, 20,000 is recorded waste — 30,000 is unexplained
    expect(result.unexplainedVariance).toBe(30_000);
  });

  it("returns a null variance % when there's no theoretical cost to compare against", () => {
    const result = buildFoodCostVariance([], 10_000, 0);
    expect(result.theoreticalCost).toBe(0);
    expect(result.variancePct).toBeNull();
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
