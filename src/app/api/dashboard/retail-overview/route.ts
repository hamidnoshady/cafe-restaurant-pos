import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getBusinessDayStatus } from "@/lib/business-day-service";
import { query } from "@/lib/db";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { industryProfile } from "@/lib/industry-profile";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Phase 25 Wave 4 — the retail counterpart of `/api/dashboard/overview`.
 *
 * That one reads open order tickets and kitchen statuses, which a shop has
 * none of; its dashboard would show a permanently empty «سفارش‌های فعال»
 * table. This reads what a shop actually wants on a Tuesday morning: what it
 * sold today, what is left on the shelf, and the one industry-specific number
 * that changes daily — the gold rate for a jeweller, open repair tickets for a
 * watch shop.
 *
 * Deliberately a separate read model rather than a branch inside the F&B
 * overview: nothing here shares a query with it, and merging them would mean
 * one route answering two unrelated questions.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "accountant");
  if (error) return error;

  const industry = (await getBusinessIndustry(session.businessId)) ?? "food_service";
  if (industryProfile(industry).salesModel !== "retail_invoice") {
    return NextResponse.json({ error: "industry_mismatch" }, { status: 403 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({
      industry,
      today: { invoiceCount: 0, total: "0" },
      stock: { inStock: 0, lowStock: 0 },
      goldPrices: [],
      openRepairs: 0,
    });
  }

  // "Today" is the branch's business day (روز کاری, migration 0076), which for a
  // shop that has configured none is its calendar day in its own timezone — what
  // this always read, and why a shop closing at 23:00 Tehran time still sees that
  // sale on today's figure. A late-trading shop that has configured one gets its
  // whole service on one figure instead of a total that resets at midnight.
  const businessDay = await getBusinessDayStatus(location.id);
  const { rows: todayRows } = await query<{ invoice_count: string; total: string }>(
    `SELECT count(*) AS invoice_count, COALESCE(SUM(total), 0)::text AS total
       FROM orders
      WHERE location_id = $1
        AND type = 'retail'
        AND status = 'completed'
        AND closed_at >= $2::timestamptz`,
    [location.id, businessDay?.windowStart ?? new Date().toISOString()],
  );

  // What is sellable right now, across whichever of the three item shapes this
  // industry uses. A weighed piece and a serialised unit are each one thing;
  // an accessories variant is a quantity.
  const { rows: stockRows } = await query<{ in_stock: string; low_stock: string }>(
    `SELECT
       (SELECT count(*) FROM item_weight_attributes w
          JOIN items i ON i.id = w.item_id
         WHERE i.location_id = $1 AND w.status = 'in_stock')
     + (SELECT count(*) FROM item_serials s
          JOIN items i ON i.id = s.item_id
         WHERE i.location_id = $1 AND s.status = 'in_stock')
     + (SELECT count(*) FROM item_stock st
          JOIN items i ON i.id = st.item_id
         WHERE i.location_id = $1 AND st.quantity > 0) AS in_stock,
       (SELECT count(*) FROM item_stock st
          JOIN items i ON i.id = st.item_id
         WHERE i.location_id = $1 AND st.quantity <= 0) AS low_stock`,
    [location.id],
  );

  const goldPrices =
    industry === "jewelry"
      ? (
          await query<{ purity: string; price_per_gram: string; price_date: string }>(
            `SELECT DISTINCT ON (purity) purity, price_per_gram::text, price_date::text
               FROM gold_prices
              WHERE business_id = $1
              ORDER BY purity, price_date DESC`,
            [session.businessId],
          )
        ).rows.map((r) => ({
          purity: r.purity,
          pricePerGram: Number(r.price_per_gram),
          priceDate: r.price_date,
        }))
      : [];

  const openRepairs =
    industry === "watch"
      ? Number(
          (
            await query<{ count: string }>(
              `SELECT count(*) FROM repair_tickets r
                 WHERE r.location_id = $1 AND r.status NOT IN ('closed', 'cancelled')`,
              [location.id],
            )
          ).rows[0]?.count ?? 0,
        )
      : 0;

  return NextResponse.json({
    industry,
    today: {
      invoiceCount: Number(todayRows[0]?.invoice_count ?? 0),
      total: todayRows[0]?.total ?? "0",
    },
    stock: {
      inStock: Number(stockRows[0]?.in_stock ?? 0),
      lowStock: Number(stockRows[0]?.low_stock ?? 0),
    },
    goldPrices,
    openRepairs,
    businessDay,
  });
});
