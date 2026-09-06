import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";

/**
 * Growth & Marketing's customer projection.
 *
 * The customer *record* belongs to the CRM; Growth may not create or edit it.
 * What Growth may do is show the audience with the numbers its own workflows
 * answer against — lifecycle/RFM stage, loyalty points, purchase history — so
 * the customers screen is a growth view of the shared `parties` record, not a
 * second customer table.
 *
 * Read-only. Accountants are admitted because Growth's customer projection is
 * the read-only surface Phase 40 gave Accounting; the full CRM file and any
 * edit remain behind the CRM's own gates.
 */

interface GrowthCustomerRow extends Record<string, unknown> {
  customer_id: string;
  name: string;
  phone: string | null;
  is_active: boolean;
  lifecycle_stage: string | null;
  points: number;
  order_count: number;
  total_spent: string | null;
  last_purchase_date: string | null;
}

export interface GrowthCustomer {
  id: string;
  displayName: string;
  phone: string | null;
  isActive: boolean;
  lifecycleStage: string | null;
  points: number;
  orderCount: number;
  totalSpentRial: number;
  lastPurchaseDate: string | null;
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const id = request.nextUrl.searchParams.get("id")?.trim() ?? "";
  const params: unknown[] = [session.businessId];
  let search = "";
  if (id) {
    params.push(id);
    // Deep-link support: a customer outside the first projection page can still
    // be opened by its shared record id.
    search = `AND c.id = $2`;
  } else if (q) {
    params.push(`%${q.toLocaleLowerCase()}%`);
    // A marketing list can use a plain case-insensitive match on the name and
    // the typed phone. Canonical duplicate detection is CRM's job; this view is
    // a projection, not a record-identity decision.
    search = `AND (LOWER(c.name) LIKE $2 OR COALESCE(c.phone, '') LIKE $2)`;
  }

  const { rows } = await query<GrowthCustomerRow>(
    `SELECT c.id AS customer_id, c.name, c.phone, c.is_active AS is_active,
            c.lifecycle_stage AS lifecycle_stage,
            COALESCE(ps.points, 0)::int AS points,
            COALESCE(os.order_count, 0)::int AS order_count,
            COALESCE(os.total_spent, 0)::bigint AS total_spent,
            os.last_purchase_date::text AS last_purchase_date
       FROM parties c
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(points), 0)::int AS points
           FROM customer_points
          WHERE customer_id = c.id AND business_id = $1
       ) ps ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS order_count,
                COALESCE(SUM(o.total), 0)::bigint AS total_spent,
                MAX(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)) AS last_purchase_date
           FROM orders o
           JOIN locations l ON l.id = o.location_id
          WHERE o.customer_id = c.id AND l.business_id = $1
            AND o.status = 'completed' AND o.closed_at IS NOT NULL
       ) os ON true
      WHERE c.business_id = $1
        AND c.role = 'customer'
        AND c.merged_into_id IS NULL
        ${search}
      ORDER BY c.name
      LIMIT 200`,
    params,
  );

  const customers: GrowthCustomer[] = rows.map((row) => ({
    id: row.customer_id,
    displayName: row.name,
    phone: row.phone,
    isActive: row.is_active,
    lifecycleStage: row.lifecycle_stage,
    points: Number(row.points ?? 0),
    orderCount: Number(row.order_count ?? 0),
    totalSpentRial: Number(row.total_spent ?? 0),
    lastPurchaseDate: row.last_purchase_date,
  }));

  return NextResponse.json({ customers });
});
