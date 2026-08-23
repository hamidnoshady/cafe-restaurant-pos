/**
 * Server-side executors for the assistant's read-only tools. These run with the
 * caller's business scope and never mutate data — mutations always go through the
 * confirmed-action flow (propose_action → human "Apply" → existing API endpoint).
 *
 * Phase 18b Wave 1 adds one `runReadTool` case per module below, each backed by
 * an existing reporting view/service function wherever one exists (never a new
 * mutation path). Four tools from the phase doc's Wave 1 list aren't implemented
 * yet because the data they'd need doesn't exist in the schema at all —
 * `get_expiring_batches` (no expiry/shelf-life column anywhere), `get_delivery_zone_heatmap`
 * (deliveries carry a free-text address, no zone/geo data), `get_shift_coverage_gaps`
 * and `get_overtime_summary` (no staff shift/clock-in entity — Phase 8's own doc
 * already notes there's no till/shift entity in the schema). Wiring those needs a
 * schema decision first, not just another read tool.
 */
import { businessToday } from "./business-day-service";
import { shiftIsoDate } from "./business-day";
import { query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { STANDARD_REPORTS } from "./reports";
import {
  getBalanceSheet,
  getProfitAndLoss,
  getVatReport,
  runStandardReportRows,
} from "./reports-service";
import { computeSetupState } from "./setup-state";
import { getArAging } from "./ar-service";
import { getApAging } from "./ap-service";
import { listPayrollRuns, listStaffWages } from "./payroll-service";
import { listBranches } from "./branch-service";
import { getCustomer } from "./customers-service";
import { computeSessionBill } from "./table-session-service";
import { evenSplit } from "./table-sessions";
import { nearExpiryBatches } from "./cosmetics-service";
import { staffCommissionReport } from "./commission-service";
import { customersDueForRepurchase } from "./loyalty-service";
import { getBusinessIndustry } from "./industry-guard";
import { runAccountingReview } from "./accounting-review-service";
import { summarizeFindings } from "./accounting-review";
import { countPendingCoworkerRuns, listCoworkerJobs } from "./ai-coworker-service";

export interface ToolResult {
  ok: boolean;
  data: unknown;
}

/** The business's primary (oldest active) location — the same shape businessTimezone uses for a per-tenant default. */
async function primaryLocationId(businessId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  return rows[0]?.id ?? null;
}

/**
 * The floor assistant has a deliberately narrower scope than dashboard mode:
 * one active location, and—when the caller is a waiter—only the tables in
 * sections assigned to that member.
 */
export interface FloorReadScope {
  locationId: string;
  userId: string;
  role: "cashier" | "waiter";
}

/** Cap rows/size so a big report can't blow the model's context window. */
function cap<T>(rows: T[], limit = 50): T[] {
  return rows.slice(0, limit);
}

/**
 * Default lookback window for tools that accept an optional date range.
 *
 * Anchored on the business's own business date, not on `new Date()`. Both of
 * this function's earlier assumptions were wrong for a Tehran evening: the UTC
 * date rolls over at 03:30 local, so "today" became tomorrow for the last hours
 * of every night; and a branch trading past midnight files those hours under
 * the previous business day anyway. Since every view these tools read is
 * bucketed by `app_business_date`, asking for a range in anything else means
 * the assistant quietly answers about the wrong day.
 */
async function defaultRange(
  businessId: string,
  args: Record<string, unknown>,
  days = 30,
): Promise<{ dateFrom: string; dateTo: string }> {
  const hasFrom = typeof args.dateFrom === "string";
  const hasTo = typeof args.dateTo === "string";
  // Only pay for the lookup when the caller left a bound open.
  const today = hasFrom && hasTo ? "" : await businessToday(businessId);
  const dateTo = hasTo ? (args.dateTo as string) : today;
  const dateFrom = hasFrom ? (args.dateFrom as string) : shiftIsoDate(today, -(days - 1));
  return { dateFrom, dateTo };
}

// ---------------------------------------------------------------------------
// Wave 1 — orders & menu
// ---------------------------------------------------------------------------

async function menuPerformance(businessId: string, args: Record<string, unknown>) {
  const { dateFrom, dateTo } = await defaultRange(businessId, args);
  const { rows: sold } = await query<{
    menu_item_id: string;
    item_name: string;
    category_name: string | null;
    quantity: string;
    revenue: string;
  }>(
    `SELECT menu_item_id, max(item_name) AS item_name, max(category_name) AS category_name,
            sum(quantity)::text AS quantity, sum(revenue)::text AS revenue
       FROM v_menu_item_performance
      WHERE business_id = $1 AND sale_date BETWEEN $2 AND $3 AND menu_item_id IS NOT NULL
      GROUP BY menu_item_id
      ORDER BY sum(quantity) DESC`,
    [businessId, dateFrom, dateTo],
  );
  const shaped = sold.map((r) => ({
    menuItemId: r.menu_item_id,
    name: r.item_name,
    category: r.category_name,
    quantity: Number(r.quantity),
    revenue: Number(r.revenue),
  }));

  const { rows: neverOrdered } = await query<{ id: string; name: string; category_name: string | null }>(
    `SELECT mi.id, mi.name, mc.name AS category_name
       FROM menu_items mi
       JOIN locations l ON l.id = mi.location_id
       LEFT JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE l.business_id = $1 AND mi.is_active
        AND NOT EXISTS (
          SELECT 1 FROM order_items oi
           WHERE oi.menu_item_id = mi.id AND oi.status != 'voided'
        )
      ORDER BY mi.name`,
    [businessId],
  );

  return {
    dateFrom,
    dateTo,
    bestSellers: cap(shaped, 10),
    worstSellers: cap([...shaped].reverse(), 10),
    neverOrdered: cap(
      neverOrdered.map((r) => ({ menuItemId: r.id, name: r.name, category: r.category_name })),
      20,
    ),
  };
}

async function voidPattern(businessId: string, args: Record<string, unknown>) {
  const { dateFrom, dateTo } = await defaultRange(businessId, args);
  const { rows: byItem } = await query<{ name_snapshot: string; void_count: string }>(
    `SELECT oi.name_snapshot, count(*)::text AS void_count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN locations l ON l.id = o.location_id
      WHERE l.business_id = $1 AND oi.status = 'voided' AND oi.created_at::date BETWEEN $2 AND $3
      GROUP BY oi.name_snapshot
      ORDER BY count(*) DESC`,
    [businessId, dateFrom, dateTo],
  );
  const { rows: byOpener } = await query<{ full_name: string | null; void_count: string }>(
    `SELECT u.full_name, count(*)::text AS void_count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN locations l ON l.id = o.location_id
       LEFT JOIN users u ON u.id = o.opened_by
      WHERE l.business_id = $1 AND oi.status = 'voided' AND oi.created_at::date BETWEEN $2 AND $3
      GROUP BY o.opened_by, u.full_name
      ORDER BY count(*) DESC`,
    [businessId, dateFrom, dateTo],
  );
  const { rows: byHour } = await query<{ hour: string; void_count: string }>(
    `SELECT extract(hour FROM oi.created_at)::text AS hour, count(*)::text AS void_count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN locations l ON l.id = o.location_id
      WHERE l.business_id = $1 AND oi.status = 'voided' AND oi.created_at::date BETWEEN $2 AND $3
      GROUP BY 1 ORDER BY 1`,
    [businessId, dateFrom, dateTo],
  );

  return {
    dateFrom,
    dateTo,
    note: "«باز کننده سفارش» لزوماً همان کسی نیست که آیتم را باطل کرده — این ستون در دیتابیس ذخیره نمی‌شود.",
    byItem: cap(byItem.map((r) => ({ item: r.name_snapshot, count: Number(r.void_count) })), 15),
    byOrderOpener: cap(
      byOpener.map((r) => ({ staff: r.full_name ?? "نامشخص", count: Number(r.void_count) })),
      15,
    ),
    byHourOfDay: byHour.map((r) => ({ hour: Number(r.hour), count: Number(r.void_count) })),
  };
}

// ---------------------------------------------------------------------------
// Wave 1 — inventory
// ---------------------------------------------------------------------------

async function stockValuation(businessId: string) {
  const { rows } = await query<{
    inventory_item_id: string;
    item_name: string;
    unit: string;
    stock_qty: string;
    valuation: string;
  }>(
    `SELECT inventory_item_id, item_name, unit, stock_qty::text, valuation::text
       FROM v_inventory_valuation
      WHERE business_id = $1
      ORDER BY valuation DESC`,
    [businessId],
  );
  const shaped = rows.map((r) => ({
    inventoryItemId: r.inventory_item_id,
    name: r.item_name,
    unit: r.unit,
    stockQty: Number(r.stock_qty),
    valuation: Number(r.valuation),
  }));
  return {
    totalValuation: shaped.reduce((sum, r) => sum + r.valuation, 0),
    items: cap(shaped, 50),
  };
}

async function supplierPerformance(businessId: string, args: Record<string, unknown>) {
  const { dateFrom, dateTo } = await defaultRange(businessId, args, 90);
  const { rows } = await query<{
    supplier_id: string | null;
    supplier_name: string | null;
    purchase_count: string;
    total_spend: string;
    avg_lead_days: string | null;
  }>(
    `SELECT s.id AS supplier_id, s.name AS supplier_name,
            count(*)::text AS purchase_count,
            sum(p.total)::text AS total_spend,
            avg(extract(epoch FROM (p.received_at - p.ordered_at)) / 86400.0)::text AS avg_lead_days
       FROM purchases p
       JOIN locations l ON l.id = p.location_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE l.business_id = $1 AND p.status = 'received'
        AND p.received_at IS NOT NULL AND p.received_at::date BETWEEN $2 AND $3
      GROUP BY s.id, s.name
      ORDER BY sum(p.total) DESC`,
    [businessId, dateFrom, dateTo],
  );
  return {
    dateFrom,
    dateTo,
    suppliers: cap(
      rows.map((r) => ({
        supplierId: r.supplier_id,
        name: r.supplier_name ?? "بدون تأمین‌کننده مشخص",
        purchaseCount: Number(r.purchase_count),
        totalSpend: Number(r.total_spend),
        avgLeadDays: r.avg_lead_days === null ? null : Math.round(Number(r.avg_lead_days) * 10) / 10,
      })),
      30,
    ),
  };
}

// ---------------------------------------------------------------------------
// Wave 1 — reservations & floor
// ---------------------------------------------------------------------------

async function reservationConflicts(businessId: string) {
  const { rows } = await query<{
    table_name: string;
    a_id: string;
    a_customer: string;
    a_at: string;
    b_id: string;
    b_customer: string;
    b_at: string;
  }>(
    `SELECT dt.name AS table_name,
            a.id AS a_id, a.customer_name AS a_customer, a.reserved_at::text AS a_at,
            b.id AS b_id, b.customer_name AS b_customer, b.reserved_at::text AS b_at
       FROM reservations a
       JOIN reservations b ON b.table_id = a.table_id AND a.id < b.id
       JOIN locations l ON l.id = a.location_id
       JOIN dining_tables dt ON dt.id = a.table_id
      WHERE l.business_id = $1
        AND a.status IN ('booked', 'seated') AND b.status IN ('booked', 'seated')
        AND a.reserved_at >= now() - interval '1 day'
        AND a.reserved_at < b.reserved_at + make_interval(mins => b.duration_minutes)
        AND b.reserved_at < a.reserved_at + make_interval(mins => a.duration_minutes)
      ORDER BY a.reserved_at`,
    [businessId],
  );
  return {
    conflictCount: rows.length,
    conflicts: cap(
      rows.map((r) => ({
        table: r.table_name,
        first: { id: r.a_id, customer: r.a_customer, reservedAt: r.a_at },
        second: { id: r.b_id, customer: r.b_customer, reservedAt: r.b_at },
      })),
      30,
    ),
  };
}

async function tableTurnoverRate(businessId: string, args: Record<string, unknown>) {
  const { dateFrom, dateTo } = await defaultRange(businessId, args);
  const { rows } = await query<{
    table_id: string | null;
    table_name: string | null;
    session_count: string;
    avg_duration_minutes: string;
    avg_revenue: string;
  }>(
    `SELECT table_id, table_name, count(*)::text AS session_count,
            avg(duration_minutes)::text AS avg_duration_minutes, avg(revenue)::text AS avg_revenue
       FROM v_table_turnover
      WHERE business_id = $1 AND closed_at::date BETWEEN $2 AND $3
      GROUP BY table_id, table_name
      ORDER BY count(*) DESC`,
    [businessId, dateFrom, dateTo],
  );
  return {
    dateFrom,
    dateTo,
    tables: cap(
      rows.map((r) => ({
        tableId: r.table_id,
        name: r.table_name ?? "—",
        sessionCount: Number(r.session_count),
        avgDurationMinutes: Math.round(Number(r.avg_duration_minutes)),
        avgRevenue: Math.round(Number(r.avg_revenue)),
      })),
      30,
    ),
  };
}

// ---------------------------------------------------------------------------
// Wave 1 — delivery
// ---------------------------------------------------------------------------

async function courierPerformance(businessId: string, args: Record<string, unknown>) {
  const { dateFrom, dateTo } = await defaultRange(businessId, args);
  const { rows } = await query<{
    courier_id: string | null;
    courier_name: string | null;
    delivery_count: string;
    revenue: string;
    fees: string;
    avg_delivery_minutes: string | null;
  }>(
    `SELECT courier_id, courier_name, sum(delivery_count)::text AS delivery_count,
            sum(revenue)::text AS revenue, sum(fees)::text AS fees,
            avg(avg_delivery_minutes)::text AS avg_delivery_minutes
       FROM v_courier_performance
      WHERE business_id = $1 AND delivery_date BETWEEN $2 AND $3
      GROUP BY courier_id, courier_name
      ORDER BY sum(delivery_count) DESC`,
    [businessId, dateFrom, dateTo],
  );
  return {
    dateFrom,
    dateTo,
    couriers: cap(
      rows.map((r) => ({
        courierId: r.courier_id,
        name: r.courier_name ?? "نامشخص",
        deliveryCount: Number(r.delivery_count),
        revenue: Number(r.revenue),
        fees: Number(r.fees),
        avgDeliveryMinutes: r.avg_delivery_minutes === null ? null : Math.round(Number(r.avg_delivery_minutes)),
      })),
      30,
    ),
  };
}

// ---------------------------------------------------------------------------
// Wave 1 — customers
// ---------------------------------------------------------------------------

async function customerProfile(businessId: string, args: Record<string, unknown>) {
  const customerId = typeof args.customerId === "string" ? args.customerId : "";
  if (!customerId) return { error: "customerId لازم است." };
  const customer = await getCustomer(businessId, customerId);
  if (!customer) return { error: "مشتری یافت نشد." };

  const { rows } = await query<{
    order_count: string;
    total_spent: string;
    first_order: string | null;
    last_order: string | null;
    avg_ticket: string | null;
  }>(
    `SELECT count(*)::text AS order_count, coalesce(sum(o.total), 0)::text AS total_spent,
            min(o.closed_at)::text AS first_order, max(o.closed_at)::text AS last_order,
            avg(o.total)::text AS avg_ticket
       FROM orders o
       JOIN locations l ON l.id = o.location_id
      WHERE l.business_id = $1 AND o.customer_id = $2 AND o.status = 'completed'`,
    [businessId, customerId],
  );
  const stats = rows[0];

  return {
    customer,
    orderCount: Number(stats?.order_count ?? 0),
    totalSpent: Number(stats?.total_spent ?? 0),
    firstOrderAt: stats?.first_order ?? null,
    lastOrderAt: stats?.last_order ?? null,
    avgTicket: stats?.avg_ticket ? Math.round(Number(stats.avg_ticket)) : null,
  };
}

async function atRiskCustomers(businessId: string, args: Record<string, unknown>) {
  const minOrders = Number.isFinite(Number(args.minOrders)) ? Math.max(1, Number(args.minOrders)) : 3;
  const lapsedDays = Number.isFinite(Number(args.lapsedDays)) ? Math.max(1, Number(args.lapsedDays)) : 30;

  const { rows } = await query<{
    id: string;
    name: string;
    phone: string | null;
    order_count: string;
    total_spent: string;
    last_order: string;
  }>(
    `SELECT c.id, c.name, c.phone, count(o.id)::text AS order_count,
            sum(o.total)::text AS total_spent, max(o.closed_at)::text AS last_order
       FROM customers c
       JOIN orders o ON o.customer_id = c.id AND o.status = 'completed'
       JOIN locations l ON l.id = o.location_id AND l.business_id = c.business_id
      WHERE c.business_id = $1 AND c.is_active
      GROUP BY c.id, c.name, c.phone
      HAVING count(o.id) >= $2 AND max(o.closed_at) < now() - make_interval(days => $3::int)
      ORDER BY sum(o.total) DESC`,
    [businessId, minOrders, lapsedDays],
  );
  return {
    minOrders,
    lapsedDays,
    customers: cap(
      rows.map((r) => ({
        customerId: r.id,
        name: r.name,
        phone: r.phone,
        historicOrderCount: Number(r.order_count),
        historicTotalSpent: Number(r.total_spent),
        lastOrderAt: r.last_order,
      })),
      20,
    ),
  };
}

// ---------------------------------------------------------------------------
// Wave 1 — accounting suite
// ---------------------------------------------------------------------------

async function unreconciledBankLines(businessId: string) {
  const accountCodes: { code: string; label: "cash" | "bankClearing" }[] = [
    { code: WELL_KNOWN_CODES.cash, label: "cash" },
    { code: WELL_KNOWN_CODES.bankClearing, label: "bankClearing" },
  ];
  const results: Record<string, unknown>[] = [];
  for (const { code, label } of accountCodes) {
    const { rows } = await query<{
      journal_line_id: string;
      entry_date: string;
      memo: string | null;
      debit: string;
      credit: string;
    }>(
      `SELECT jl.id::text AS journal_line_id, je.entry_date::text AS entry_date, je.memo, jl.debit, jl.credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.business_id = $1 AND a.code = $2
          AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_lines brl WHERE brl.journal_line_id = jl.id)
        ORDER BY je.entry_date`,
      [businessId, code],
    );
    const lines = rows.map((r) => ({
      journalLineId: r.journal_line_id,
      entryDate: r.entry_date,
      memo: r.memo,
      debit: Number(r.debit),
      credit: Number(r.credit),
    }));
    results.push({
      account: label,
      unreconciledCount: lines.length,
      netAmount: lines.reduce((sum, l) => sum + l.debit - l.credit, 0),
      lines: cap(lines, 20),
    });
  }
  return { accounts: results };
}

async function apUpcoming(businessId: string) {
  const aging = await getApAging(businessId);
  return {
    asOfDate: aging.asOfDate,
    note: "این کسب‌وکار تاریخ سررسید فاکتور را ثبت نمی‌کند؛ فهرست بر اساس قدمت فاکتور (قدیمی‌ترین اول) مرتب شده تا اولویت پرداخت را نشان دهد.",
    totals: aging.totals,
    suppliers: cap(aging.rows, 30),
  };
}

// ---------------------------------------------------------------------------
// Wave 1 — cross-branch & forecasting
// ---------------------------------------------------------------------------

async function branchComparison(businessId: string, args: Record<string, unknown>) {
  const { dateFrom, dateTo } = await defaultRange(businessId, args);
  const branches = await listBranches(businessId);

  const { rows: sales } = await query<{
    location_id: string;
    order_count: string;
    revenue: string;
  }>(
    `SELECT location_id, sum(order_count)::text AS order_count, sum(total)::text AS revenue
       FROM v_sales_by_day
      WHERE business_id = $1 AND sale_date BETWEEN $2 AND $3
      GROUP BY location_id`,
    [businessId, dateFrom, dateTo],
  );
  const salesByLocation = new Map(
    sales.map((r) => [r.location_id, { orderCount: Number(r.order_count), revenue: Number(r.revenue) }]),
  );

  const { rows: wages } = await query<{ location_id: string; labor_cost: string }>(
    `SELECT location_id, coalesce(sum(monthly_wage), 0)::text AS labor_cost
       FROM users WHERE business_id = $1 AND is_active AND location_id IS NOT NULL
       GROUP BY location_id`,
    [businessId],
  );
  const laborByLocation = new Map(wages.map((r) => [r.location_id, Number(r.labor_cost)]));

  return {
    dateFrom,
    dateTo,
    note: "«هزینهٔ نیروی انسانی» برآورد حقوق ماهانهٔ کارکنان فعال هر شعبه است، نه هزینهٔ واقعی دورهٔ گزارش.",
    branches: branches.map((b) => ({
      branchId: b.id,
      name: b.name,
      isActive: b.isActive,
      orderCount: salesByLocation.get(b.id)?.orderCount ?? 0,
      revenue: salesByLocation.get(b.id)?.revenue ?? 0,
      estimatedMonthlyLaborCost: laborByLocation.get(b.id) ?? 0,
    })),
  };
}

async function forecastDemand(businessId: string, args: Record<string, unknown>) {
  const horizonDays = Number.isFinite(Number(args.horizonDays))
    ? Math.min(Math.max(1, Number(args.horizonDays)), 30)
    : 7;
  const lookbackDays = 28;
  // Same reason as defaultRange: the views this averages over are bucketed by
  // business date, so the window has to be expressed in them too.
  const dateTo = await businessToday(businessId);
  const dateFrom = shiftIsoDate(dateTo, -(lookbackDays - 1));
  const menuItemId = typeof args.menuItemId === "string" ? args.menuItemId : null;

  const disclaimer = "این یک تخمین است، نه یک پیش‌بینی قطعی — بر اساس میانگین فروش ۲۸ روز گذشته محاسبه شده است.";

  if (menuItemId) {
    const { rows } = await query<{ item_name: string | null; quantity: string }>(
      `SELECT max(item_name) AS item_name, coalesce(sum(quantity), 0)::text AS quantity
         FROM v_menu_item_performance
        WHERE business_id = $1 AND menu_item_id = $2 AND sale_date BETWEEN $3 AND $4`,
      [businessId, menuItemId, dateFrom, dateTo],
    );
    const totalQty = Number(rows[0]?.quantity ?? 0);
    const dailyAvg = totalQty / lookbackDays;
    return {
      disclaimer,
      menuItemId,
      itemName: rows[0]?.item_name ?? null,
      lookbackDays,
      horizonDays,
      historicalDailyAverage: Math.round(dailyAvg * 100) / 100,
      estimatedQuantity: Math.round(dailyAvg * horizonDays),
    };
  }

  const { rows } = await query<{ order_count: string; revenue: string }>(
    `SELECT coalesce(sum(order_count), 0)::text AS order_count, coalesce(sum(total), 0)::text AS revenue
       FROM v_sales_by_day
      WHERE business_id = $1 AND sale_date BETWEEN $2 AND $3`,
    [businessId, dateFrom, dateTo],
  );
  const dailyOrders = Number(rows[0]?.order_count ?? 0) / lookbackDays;
  const dailyRevenue = Number(rows[0]?.revenue ?? 0) / lookbackDays;
  return {
    disclaimer,
    lookbackDays,
    horizonDays,
    historicalDailyAverageOrders: Math.round(dailyOrders * 100) / 100,
    historicalDailyAverageRevenue: Math.round(dailyRevenue),
    estimatedOrders: Math.round(dailyOrders * horizonDays),
    estimatedRevenue: Math.round(dailyRevenue * horizonDays),
  };
}

// ---------------------------------------------------------------------------
// Wave 3 — cashier/waiter assistant (read-only, active location only)
// ---------------------------------------------------------------------------

function needsFloorScope(scope: FloorReadScope | undefined): scope is FloorReadScope {
  return Boolean(scope && (scope.role === "cashier" || scope.role === "waiter"));
}

type FloorMenuItemRow = {
  id: string;
  name: string;
  description: string | null;
  price: string;
  category_name: string | null;
  ingredients: unknown;
};

/**
 * Returns only ingredients explicitly recorded in the recipe. The data model
 * has no structured allergen field; that absence is deliberately surfaced to
 * the model instead of guessing from ingredient names.
 */
async function floorMenuItemDetails(scope: FloorReadScope, args: Record<string, unknown>) {
  const menuItemId = typeof args.menuItemId === "string" ? args.menuItemId.trim() : "";
  const search = typeof args.query === "string" ? args.query.trim().slice(0, 120) : "";
  if (!menuItemId && !search) {
    return { error: "برای جست‌وجوی منو، نام یا شناسهٔ آیتم لازم است." };
  }

  const itemCondition = menuItemId
    ? "mi.id = $2"
    : "mi.name ILIKE ('%' || $2 || '%')";
  const selector = menuItemId || search;
  const { rows } = await query<FloorMenuItemRow>(
    `SELECT mi.id, mi.name, mi.description, mi.price::text, mc.name AS category_name,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'inventoryItemId', ii.id,
                  'name', ii.name,
                  'unit', ii.unit,
                  'quantity', mii.quantity::text
                )
                ORDER BY ii.name
              ) FILTER (WHERE ii.id IS NOT NULL),
              '[]'::jsonb
            ) AS ingredients
       FROM menu_items mi
       LEFT JOIN menu_categories mc ON mc.id = mi.category_id
       LEFT JOIN menu_item_ingredients mii ON mii.menu_item_id = mi.id
       LEFT JOIN inventory_items ii ON ii.id = mii.inventory_item_id
      WHERE mi.location_id = $1 AND mi.is_active AND ${itemCondition}
      GROUP BY mi.id, mi.name, mi.description, mi.price, mc.name
      ORDER BY mi.name
      LIMIT 8`,
    [scope.locationId, selector],
  );

  return {
    locationId: scope.locationId,
    items: rows.map((row) => {
      const ingredients = Array.isArray(row.ingredients) ? row.ingredients : [];
      return {
        menuItemId: row.id,
        name: row.name,
        category: row.category_name,
        description: row.description,
        price: Number(row.price),
        ingredients,
        recipeAvailable: ingredients.length > 0,
        allergenData: {
          status: "not_recorded" as const,
          warning:
            "برای این آیتم فیلد آلرژن ساخت‌یافته ثبت نشده است. مواد اولیهٔ نمایش‌داده‌شده فقط دستور ثبت‌شده‌اند و ایمن‌بودن غذا را تأیید نمی‌کنند.",
        },
      };
    }),
  };
}

async function floorBillSplitPreview(scope: FloorReadScope, args: Record<string, unknown>) {
  const tableSessionId = typeof args.tableSessionId === "string" ? args.tableSessionId.trim() : "";
  const tableName = typeof args.tableName === "string" ? args.tableName.trim().slice(0, 120) : "";
  const guests = Math.trunc(Number(args.guests));
  if (!tableSessionId && !tableName) {
    return { error: "برای پیش‌نمایش تقسیم، نام میز یا شناسهٔ نشست میز لازم است." };
  }
  if (!Number.isFinite(guests) || guests < 1 || guests > 50) {
    return { error: "تعداد مهمان باید عددی بین ۱ تا ۵۰ باشد." };
  }

  const selectorSql = tableSessionId
    ? "ts.id = $2"
    : `EXISTS (
        SELECT 1
          FROM table_session_tables selector_link
          JOIN dining_tables selector_table ON selector_table.id = selector_link.table_id
         WHERE selector_link.session_id = ts.id
           AND selector_link.released_at IS NULL
           AND lower(selector_table.name) = lower($2)
      )`;

  const { rows } = await query<{ id: string; table_name: string | null }>(
    `SELECT ts.id,
            (
              SELECT dt.name
                FROM table_session_tables tst
                JOIN dining_tables dt ON dt.id = tst.table_id
               WHERE tst.session_id = ts.id AND tst.released_at IS NULL
               ORDER BY dt.sort_order, dt.name
               LIMIT 1
            ) AS table_name
       FROM table_sessions ts
      WHERE ts.location_id = $1
        AND ts.status = 'open'
        AND ${selectorSql}
        AND (
          $4::boolean
          OR EXISTS (
            SELECT 1
              FROM table_session_tables allowed_link
              JOIN dining_tables allowed_table ON allowed_table.id = allowed_link.table_id
              JOIN floor_sections allowed_section ON allowed_section.id = allowed_table.section_id
             WHERE allowed_link.session_id = ts.id
               AND allowed_link.released_at IS NULL
               AND allowed_section.assigned_waiter_id = $3
          )
        )
      LIMIT 2`,
    [scope.locationId, tableSessionId || tableName, scope.userId, scope.role === "cashier"],
  );
  const session = rows[0];
  if (!session) {
    return { error: "نشست بازِ قابل‌دسترسی برای این میز پیدا نشد." };
  }
  if (rows.length > 1) {
    return { error: "بیش از یک نشست باز پیدا شد؛ شناسهٔ نشست میز را مشخص کنید." };
  }

  const bill = await computeSessionBill(session.id);
  return {
    tableSessionId: session.id,
    tableName: session.table_name,
    guests,
    total: bill.total,
    equalShares: evenSplit(bill.total, guests),
    lines: cap(
      bill.lines.map((line) => ({
        name: line.name,
        amount: line.amount,
      })),
      50,
    ),
    notice:
      "این فقط پیش‌نمایش تقسیم برابر است و هیچ پرداخت یا تقسیم صورت‌حسابی ثبت نشده است؛ اجرای نهایی فقط از جریان عادی POS انجام می‌شود.",
  };
}

// ---------------------------------------------------------------------------

export async function runReadTool(
  name: string,
  args: Record<string, unknown>,
  businessId: string,
  floorScope?: FloorReadScope,
): Promise<ToolResult> {
  switch (name) {
    case "get_setup_state": {
      const state = await computeSetupState(businessId);
      // Trim to what the model needs — drop nothing important but keep it compact.
      return {
        ok: true,
        data: {
          business: state.business,
          location: state.location,
          prefs: state.prefs,
          costing: state.costing,
          tax: state.tax,
          counts: state.counts,
          completedSteps: Object.keys(state.progress.steps),
          completedAt: state.progress.completedAt,
          missingForCompletion: state.missingForCompletion,
        },
      };
    }

    case "list_reports": {
      return {
        ok: true,
        data: STANDARD_REPORTS.map((r) => ({ key: r.key, label: r.label })),
      };
    }

    case "run_report": {
      const key = typeof args.key === "string" ? args.key : "";
      const def = STANDARD_REPORTS.find((r) => r.key === key);
      if (!def) {
        return {
          ok: false,
          data: {
            error: "کلید گزارش نامعتبر است. اول list_reports را صدا بزن.",
            validKeys: STANDARD_REPORTS.map((r) => r.key),
          },
        };
      }
      const dateFrom = typeof args.dateFrom === "string" ? args.dateFrom : undefined;
      const dateTo = typeof args.dateTo === "string" ? args.dateTo : undefined;

      if (key === "profit_and_loss") {
        return { ok: true, data: await getProfitAndLoss(businessId, { dateFrom, dateTo }) };
      }
      if (key === "balance_sheet") {
        return { ok: true, data: await getBalanceSheet(businessId, dateTo) };
      }
      const rows = await runStandardReportRows(key, businessId, { dateFrom, dateTo });
      return { ok: true, data: { label: def.label, rowCount: rows.length, rows: cap(rows) } };
    }

    case "get_menu_performance":
      return { ok: true, data: await menuPerformance(businessId, args) };

    case "get_void_pattern":
      return { ok: true, data: await voidPattern(businessId, args) };

    case "get_stock_valuation":
      return { ok: true, data: await stockValuation(businessId) };

    case "get_supplier_performance":
      return { ok: true, data: await supplierPerformance(businessId, args) };

    case "get_reservation_conflicts":
      return { ok: true, data: await reservationConflicts(businessId) };

    case "get_table_turnover_rate":
      return { ok: true, data: await tableTurnoverRate(businessId, args) };

    case "get_courier_performance":
      return { ok: true, data: await courierPerformance(businessId, args) };

    case "get_customer_profile":
      return { ok: true, data: await customerProfile(businessId, args) };

    case "get_at_risk_customers":
      return { ok: true, data: await atRiskCustomers(businessId, args) };

    case "get_ar_aging": {
      const asOfDate = typeof args.asOfDate === "string" ? args.asOfDate : undefined;
      const report = await getArAging(businessId, asOfDate);
      return { ok: true, data: { ...report, rows: cap(report.rows, 30) } };
    }

    case "get_ap_upcoming":
      return { ok: true, data: await apUpcoming(businessId) };

    case "get_unreconciled_bank_lines":
      return { ok: true, data: await unreconciledBankLines(businessId) };

    case "get_payroll_summary": {
      const [runs, wages] = await Promise.all([listPayrollRuns(businessId), listStaffWages(businessId)]);
      const staffWithWage = wages.filter((w) => w.monthlyWage !== null);
      return {
        ok: true,
        data: {
          recentRuns: cap(runs, 6),
          staffCount: wages.length,
          staffWithWageCount: staffWithWage.length,
          totalMonthlyWageBill: staffWithWage.reduce((sum, w) => sum + (w.monthlyWage ?? 0), 0),
        },
      };
    }

    case "get_vat_liability": {
      const dateFrom = typeof args.dateFrom === "string" ? args.dateFrom : undefined;
      const dateTo = typeof args.dateTo === "string" ? args.dateTo : undefined;
      return { ok: true, data: await getVatReport(businessId, { dateFrom, dateTo }) };
    }

    case "get_branch_comparison":
      return { ok: true, data: await branchComparison(businessId, args) };

    case "forecast_demand":
      return { ok: true, data: await forecastDemand(businessId, args) };

    case "get_menu_item_details":
      return needsFloorScope(floorScope)
        ? { ok: true, data: await floorMenuItemDetails(floorScope, args) }
        : { ok: false, data: { error: "این ابزار فقط برای دستیار صندوق/گارسون مجاز است." } };

    case "get_bill_split_preview":
      return needsFloorScope(floorScope)
        ? { ok: true, data: await floorBillSplitPreview(floorScope, args) }
        : { ok: false, data: { error: "این ابزار فقط برای دستیار صندوق/گارسون مجاز است." } };

    case "get_near_expiry_items": {
      const industry = await getBusinessIndustry(businessId);
      if (industry !== "cosmetics") {
        return { ok: false, data: { error: "این ابزار فقط برای کسب‌وکارهای آرایشی و بهداشتی در دسترس است." } };
      }
      const locationId = await primaryLocationId(businessId);
      if (!locationId) return { ok: true, data: [] };
      return { ok: true, data: await nearExpiryBatches(locationId) };
    }

    case "get_staff_commission": {
      const dateFrom = typeof args.dateFrom === "string" ? args.dateFrom : undefined;
      const dateTo = typeof args.dateTo === "string" ? args.dateTo : undefined;
      return { ok: true, data: await staffCommissionReport(businessId, { from: dateFrom, to: dateTo }) };
    }

    case "get_repurchase_candidates": {
      const locationId = await primaryLocationId(businessId);
      if (!locationId) return { ok: true, data: [] };
      const today = new Date().toISOString().slice(0, 10);
      return { ok: true, data: await customersDueForRepurchase(businessId, locationId, today) };
    }

    // Phase 32 — the coworker's two read tools. Both are deterministic: the
    // review is a rule engine (see accounting-review.ts on why an LLM must not
    // be the thing that finds a bookkeeping error), and the job list is the
    // owner's own standing instructions read back to them.
    case "run_accounting_review": {
      const asOfDate = typeof args.asOfDate === "string" ? args.asOfDate : undefined;
      const review = await runAccountingReview(businessId, { asOfDate });
      return {
        ok: true,
        data: {
          asOfDate: review.asOfDate,
          windowDays: review.windowDays,
          headline: summarizeFindings(review.findings),
          findings: cap(review.findings, 15),
        },
      };
    }

    case "list_coworker_jobs": {
      const jobs = await listCoworkerJobs(businessId);
      const pendingCount = await countPendingCoworkerRuns(businessId);
      return {
        ok: true,
        data: {
          pendingApprovalCount: pendingCount,
          jobs: cap(
            jobs.map((job) => ({
              id: job.id,
              title: job.title,
              templateKey: job.templateKey,
              trigger: job.triggerKind,
              event: job.eventKind,
              scheduleHour: job.scheduleHour,
              approvalMode: job.approvalMode,
              enabled: job.enabled,
              lastRunAt: job.lastRunAt,
            })),
            30,
          ),
        },
      };
    }

    default:
      return { ok: false, data: { error: `ابزار ناشناخته: ${name}` } };
  }
}

export const READ_TOOL_NAMES = new Set([
  "get_setup_state",
  "list_reports",
  "run_report",
  "get_menu_performance",
  "get_void_pattern",
  "get_stock_valuation",
  "get_supplier_performance",
  "get_reservation_conflicts",
  "get_table_turnover_rate",
  "get_courier_performance",
  "get_customer_profile",
  "get_at_risk_customers",
  "get_ar_aging",
  "get_ap_upcoming",
  "get_unreconciled_bank_lines",
  "get_payroll_summary",
  "get_vat_liability",
  "get_branch_comparison",
  "forecast_demand",
  "get_menu_item_details",
  "get_bill_split_preview",
  "get_near_expiry_items",
  "get_staff_commission",
  "get_repurchase_candidates",
  "run_accounting_review",
  "list_coworker_jobs",
]);
