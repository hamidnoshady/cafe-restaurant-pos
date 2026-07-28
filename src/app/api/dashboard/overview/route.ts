import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

type KitchenStatus = "new" | "preparing" | "ready";

interface LocationContextRow extends Record<string, unknown> {
  business_name: string;
  location_name: string;
  timezone: string;
}

interface SalesRow extends Record<string, unknown> {
  sales: string;
  order_count: string;
  average_order_value: string;
}

interface HourlyRow extends Record<string, unknown> {
  hour: number;
  revenue: string;
}

interface ActiveOrderRow extends Record<string, unknown> {
  id: string;
  order_number: string;
  type: "dine_in" | "takeaway" | "delivery";
  table_name: string | null;
  items: string;
  kitchen_status: KitchenStatus;
  opened_at: string;
  active_order_count: number;
}

/**
 * The shift-manager overview deliberately reads only completed sales and the
 * currently active branch. It adds a dashboard-specific read model without
 * changing the established orders or reports API contracts.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({
      businessName: "کسب‌وکار",
      locationName: "",
      timeZone: "Asia/Tehran",
      generatedAt: new Date().toISOString(),
      kpis: { sales: "0", orderCount: "0", averageOrderValue: "0" },
      hourly: [],
      activeOrderCount: 0,
      activeOrders: [],
    });
  }

  const { rows: contextRows } = await query<LocationContextRow>(
    `SELECT b.name AS business_name, l.name AS location_name, l.timezone
       FROM locations l
       JOIN businesses b ON b.id = l.business_id
      WHERE l.id = $1`,
    [location.id],
  );
  const context = contextRows[0];
  if (!context) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const [salesResult, hourlyResult, activeOrderResult] = await Promise.all([
    query<SalesRow>(
      `SELECT
          coalesce(sum(o.total), 0)::text AS sales,
          count(*)::text AS order_count,
          coalesce(round(avg(o.total)), 0)::bigint::text AS average_order_value
         FROM orders o
        WHERE o.location_id = $1
          AND o.status = 'completed'
          AND o.closed_at IS NOT NULL
          AND (o.closed_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
      [location.id, context.timezone],
    ),
    query<HourlyRow>(
      `SELECT
          extract(hour FROM (o.closed_at AT TIME ZONE $2))::integer AS hour,
          coalesce(sum(o.total), 0)::text AS revenue
         FROM orders o
        WHERE o.location_id = $1
          AND o.status = 'completed'
          AND o.closed_at IS NOT NULL
          AND (o.closed_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date
        GROUP BY 1
        ORDER BY 1`,
      [location.id, context.timezone],
    ),
    query<ActiveOrderRow>(
      `SELECT
          o.id,
          o.order_number::text AS order_number,
          o.type::text AS type,
          dt.name AS table_name,
          coalesce(string_agg(oi.name_snapshot, '، ' ORDER BY oi.created_at) FILTER (WHERE oi.id IS NOT NULL), '') AS items,
          CASE
            WHEN bool_and(oi.status IN ('ready', 'served')) FILTER (WHERE oi.id IS NOT NULL) THEN 'ready'
            WHEN bool_or(oi.status IN ('sent', 'preparing')) FILTER (WHERE oi.id IS NOT NULL) THEN 'preparing'
            ELSE 'new'
          END AS kitchen_status,
          o.opened_at,
          count(*) OVER ()::integer AS active_order_count
         FROM orders o
         LEFT JOIN dining_tables dt ON dt.id = o.table_id
         LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.status <> 'voided'
        WHERE o.location_id = $1 AND o.status = 'open'
        GROUP BY o.id, o.order_number, o.type, dt.name, o.opened_at
        ORDER BY o.opened_at ASC
        LIMIT 4`,
      [location.id],
    ),
  ]);

  const sales = salesResult.rows[0] ?? { sales: "0", order_count: "0", average_order_value: "0" };
  const activeOrders = activeOrderResult.rows.map((order) => ({
    id: order.id,
    orderNumber: order.order_number,
    type: order.type,
    tableName: order.table_name,
    items: order.items,
    kitchenStatus: order.kitchen_status,
    openedAt: order.opened_at,
  }));

  return NextResponse.json({
    businessName: context.business_name,
    locationName: context.location_name,
    timeZone: context.timezone,
    generatedAt: new Date().toISOString(),
    kpis: {
      sales: sales.sales,
      orderCount: sales.order_count,
      averageOrderValue: sales.average_order_value,
    },
    hourly: hourlyResult.rows.map((row) => ({ hour: Number(row.hour), revenue: row.revenue })),
    activeOrderCount: Number(activeOrderResult.rows[0]?.active_order_count ?? 0),
    activeOrders,
  });
});
