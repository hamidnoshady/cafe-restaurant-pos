/**
 * Phase 36b — the Growth & Marketing app's dashboard query.
 *
 * Loyalty, campaigns/gift cards and commission each already had a service and
 * a report (`loyalty-service.ts`, `promotions-service.ts`,
 * `commission-service.ts`), and each already posted to the ledger through the
 * domain-event engine — but nothing could answer the owner's actual question,
 * «بازاریابی‌ام چه خبر؟», in one place. The three facts lived on three flat
 * pages, and the liabilities they created were only visible inside accounting.
 *
 * This file is that one place. It reads only existing tables — no new ledger
 * writes, no second source of truth for any number: every balance in the
 * "bridge" is reconstructed from `journal_lines` the same way the trial
 * balance reconstructs it, because a marketing dashboard that disagrees with
 * the books is worse than no dashboard.
 *
 * Windows are rolling 30-day ranges over the stored Gregorian ISO date
 * convention, labelled in the UI as «۳۰ روز گذشته» — deliberately not a
 * calendar month, so the number means the same thing on any day it is opened.
 */

import { query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { customersDueForRepurchase, getDefaultProgram, type DueForRepurchaseRow } from "./loyalty-service";
import {
  accountBalance,
  campaignStateCounts,
  classifyCampaign,
  GROWTH_BRIDGE_CODES,
  rollingWindow,
  type CampaignState,
} from "./growth-shared";

// The app's pure half (also imported by its client screens) is re-exported
// here so server callers have one door into the Growth app's data layer.
export { accountBalance, campaignStateCounts, classifyCampaign, GROWTH_BRIDGE_CODES, rollingWindow };
export type { CampaignState };

/** The campaign ordering the dashboard lists in: what is running first, what is next, history last. */
const STATE_ORDER: Record<CampaignState, number> = { live: 0, scheduled: 1, paused: 2, ended: 3 };

export interface CampaignSummaryRow {
  id: string;
  name: string;
  kind: string;
  value: number;
  state: CampaignState;
  activeFrom: string | null;
  activeTo: string | null;
}

export interface CampaignPerformanceRow {
  promotionId: string;
  promotionName: string;
  applications: number;
  discountRial: number;
}

export interface StaffAccrualRow {
  employeeId: string;
  employeeName: string;
  amount: number;
}

export interface BridgeRow {
  code: string;
  name: string;
  /** "liability" | "expense" | … — decides how the balance is signed. */
  type: string;
  balance: number;
}

export type GrowthActivityKind = "campaign" | "points" | "gift_card" | "commission";

export interface GrowthActivityRow {
  at: string;
  kind: GrowthActivityKind;
  /** Who/what the row is about: campaign name, customer name, card code, staff name. */
  subject: string;
  /** Points for `points` rows (signed), Rial for the others. */
  amount: number;
  sourceType: string | null;
}

export interface GrowthOverview {
  window: { from: string; to: string };
  /**
   * Whether the reader actually has a branch in context. `repurchase` is a
   * per-branch prediction, so without one its `due` is 0 *because nothing was
   * asked*, not because nobody is due — a difference the dashboard has to be
   * able to say out loud instead of printing a confident «۰».
   */
  hasLocation: boolean;
  campaigns: {
    counts: Record<CampaignState, number>;
    list: CampaignSummaryRow[];
    applications: number;
    discountRial: number;
    top: CampaignPerformanceRow[];
  };
  loyalty: {
    programs: number;
    pointsOutstanding: number;
    /** The Rial value the outstanding points would redeem to at the default program's rate — an estimate, labelled as one. */
    pointsValueEstimate: number;
    earned30d: number;
    redeemed30d: number;
    customersWithPoints: number;
    customersTotal: number;
  };
  giftCards: {
    issued30d: number;
    issuedValue30d: number;
    /** The 2420 balance — the real liability, from the ledger. */
    outstandingRial: number;
  };
  commission: {
    accrued30d: number;
    top: StaffAccrualRow[];
  };
  repurchase: {
    due: number;
    sample: DueForRepurchaseRow[];
  };
  /** The Growth app's connection to accounting, as balances: 2410, 2420, 2300, 5210. */
  bridge: BridgeRow[];
  activity: GrowthActivityRow[];
}

/**
 * Everything the Growth dashboard shows, in one call. Reads only — this app
 * manages marketing; the moment it wants to move money it goes through the
 * posting rules its services already own.
 */
export async function growthOverview(
  businessId: string,
  opts: { locationId: string | null; today: string },
): Promise<GrowthOverview> {
  const { from, to } = rollingWindow(opts.today);

  const [
    promoRows,
    perfRows,
    pointRows,
    customerRows,
    programRows,
    giftCardRows,
    commissionRows,
    accountRows,
    activityRows,
    repurchase,
  ] = await Promise.all([
    query<{
      id: string;
      name: string;
      kind: string;
      value: string;
      active_from: string | null;
      active_to: string | null;
      is_active: boolean;
    }>(
      `SELECT id, name, kind, value, active_from::text, active_to::text, is_active
         FROM promotions
        WHERE business_id = $1
        ORDER BY created_at DESC`,
      [businessId],
    ),
    query<{ promotion_id: string; promotion_name: string | null; applications: number; discount: string }>(
      `SELECT pa.promotion_id, p.name AS promotion_name,
              COUNT(*)::int AS applications,
              COALESCE(SUM(pa.discount_rial), 0)::text AS discount
         FROM promotion_applications pa
         LEFT JOIN promotions p ON p.id = pa.promotion_id
        WHERE pa.business_id = $1
          AND pa.created_at::date >= $2 AND pa.created_at::date <= $3
        GROUP BY pa.promotion_id, p.name`,
      [businessId, from, to],
    ),
    query<{
      earned: number;
      redeemed: number;
      outstanding: number;
      customers_with_points: number;
    }>(
      // `customers_with_points` is a count of *balances*, not of rows: the old
      // COUNT(DISTINCT customer_id) over the whole ledger counted anyone who
      // had ever earned a point, including customers who have since spent
      // every one of them — so the dashboard could claim more point-holders
      // than there were points. The per-customer sum is taken first and only
      // the positive balances are counted, which is the same definition
      // `pointsBalance` gives one customer.
      `WITH balances AS (
         SELECT customer_id, SUM(points)::int AS balance
           FROM customer_points
          WHERE business_id = $1
          GROUP BY customer_id
       )
       SELECT
              COALESCE((SELECT SUM(points) FILTER (WHERE points > 0)
                          FROM customer_points
                         WHERE business_id = $1
                           AND created_at::date >= $2 AND created_at::date <= $3), 0)::int AS earned,
              COALESCE((SELECT -SUM(points) FILTER (WHERE points < 0)
                          FROM customer_points
                         WHERE business_id = $1
                           AND created_at::date >= $2 AND created_at::date <= $3), 0)::int AS redeemed,
              COALESCE((SELECT SUM(balance) FROM balances), 0)::int AS outstanding,
              (SELECT COUNT(*) FROM balances WHERE balance > 0)::int AS customers_with_points`,
      [businessId, from, to],
    ),
    // Only *customers*, and only the surviving record of a merge: `parties`
    // holds employees and suppliers on the same table since migration 0137, so
    // the unfiltered COUNT(*) made «۱۲ مشتری از ۹۰» compare point-holders with
    // the whole counterparty book — staff, suppliers, merged duplicates and
    // archived rows included.
    query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
         FROM parties
        WHERE business_id = $1 AND role = 'customer' AND is_active AND merged_into_id IS NULL`,
      [businessId],
    ),
    query<{ programs: number }>(
      `SELECT COUNT(*)::int AS programs FROM loyalty_programs WHERE business_id = $1 AND is_active`,
      [businessId],
    ),
    query<{ issued: number; value: string }>(
      `SELECT COUNT(*)::int AS issued, COALESCE(SUM(initial_value), 0)::text AS value
         FROM gift_cards
        WHERE business_id = $1 AND created_at::date >= $2 AND created_at::date <= $3`,
      [businessId, from, to],
    ),
    query<{ employee_id: string; employee_name: string | null; amount: string }>(
      `SELECT a.employee_id, COALESCE(u.full_name, 'نامشخص') AS employee_name,
              COALESCE(SUM(a.amount), 0)::text AS amount
         FROM commission_accruals a
         LEFT JOIN users u ON u.id = a.employee_id
        WHERE a.business_id = $1
          AND a.created_at::date >= $2 AND a.created_at::date <= $3
        GROUP BY a.employee_id, u.full_name
        ORDER BY COALESCE(SUM(a.amount), 0) DESC`,
      [businessId, from, to],
    ),
    query<{ code: string; name: string; type: string; debit: string; credit: string }>(
      `SELECT a.code, a.name, a.type::text, COALESCE(SUM(jl.debit), 0)::text AS debit, COALESCE(SUM(jl.credit), 0)::text AS credit
         FROM accounts a
         LEFT JOIN journal_lines jl ON jl.account_id = a.id
        WHERE a.business_id = $1 AND a.code = ANY($2::text[])
        GROUP BY a.id
        ORDER BY a.code`,
      [businessId, [...GROWTH_BRIDGE_CODES]],
    ),
    query<{
      at: string;
      kind: GrowthActivityKind;
      subject: string | null;
      amount: string;
      source_type: string | null;
    }>(
      `(SELECT pa.created_at AS at, 'campaign' AS kind, p.name AS subject, pa.discount_rial::text AS amount, NULL::text AS source_type
          FROM promotion_applications pa
          LEFT JOIN promotions p ON p.id = pa.promotion_id
         WHERE pa.business_id = $1
         ORDER BY pa.created_at DESC LIMIT 5)
        UNION ALL
       (SELECT cp.created_at, 'points' AS kind, c.name AS subject, cp.points::text AS amount, cp.source_type
          FROM customer_points cp
          JOIN parties c ON c.id = cp.customer_id
         WHERE cp.business_id = $1
         ORDER BY cp.created_at DESC LIMIT 5)
        UNION ALL
       (SELECT gc.created_at, 'gift_card' AS kind, gc.code AS subject, gc.initial_value::text AS amount, NULL::text AS source_type
          FROM gift_cards gc
         WHERE gc.business_id = $1
         ORDER BY gc.created_at DESC LIMIT 5)
        UNION ALL
       (SELECT ca.created_at, 'commission' AS kind, COALESCE(u.full_name, 'نامشخص') AS subject, ca.amount::text AS amount, ca.source_type
          FROM commission_accruals ca
          LEFT JOIN users u ON u.id = ca.employee_id
         WHERE ca.business_id = $1
         ORDER BY ca.created_at DESC LIMIT 5)
        ORDER BY at DESC
        LIMIT 8`,
      [businessId],
    ),
    opts.locationId
      ? customersDueForRepurchase(businessId, opts.locationId, opts.today)
      : Promise.resolve([] as DueForRepurchaseRow[]),
  ]);

  const campaignList: CampaignSummaryRow[] = promoRows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    value: Number(row.value),
    state: classifyCampaign(
      { isActive: row.is_active, activeFrom: row.active_from, activeTo: row.active_to },
      opts.today,
    ),
    activeFrom: row.active_from,
    activeTo: row.active_to,
  }));
  campaignList.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));

  const performance: CampaignPerformanceRow[] = perfRows.rows
    .map((row) => ({
      promotionId: row.promotion_id,
      promotionName: row.promotion_name ?? row.promotion_id,
      applications: Number(row.applications),
      discountRial: Number(row.discount),
    }))
    .sort((a, b) => b.discountRial - a.discountRial || b.applications - a.applications);

  const commissionAccruals: StaffAccrualRow[] = commissionRows.rows.map((row) => ({
    employeeId: row.employee_id,
    employeeName: row.employee_name ?? "نامشخص",
    amount: Number(row.amount),
  }));

  const bridge: BridgeRow[] = accountRows.rows.map((row) => ({
    code: row.code,
    name: row.name,
    type: row.type,
    balance: accountBalance(row.type, Number(row.debit), Number(row.credit)),
  }));

  const points = pointRows.rows[0] ?? {
    earned: 0,
    redeemed: 0,
    outstanding: 0,
    customers_with_points: 0,
  };
  const program = await getDefaultProgram(businessId);

  return {
    window: { from, to },
    hasLocation: Boolean(opts.locationId),
    campaigns: {
      counts: campaignStateCounts(campaignList.map((c) => c.state)),
      list: campaignList.slice(0, 6),
      applications: performance.reduce((sum, row) => sum + row.applications, 0),
      discountRial: performance.reduce((sum, row) => sum + row.discountRial, 0),
      top: performance.slice(0, 3),
    },
    loyalty: {
      programs: programRows.rows[0]?.programs ?? 0,
      pointsOutstanding: points.outstanding,
      pointsValueEstimate: points.outstanding * (program?.pointValueRial ?? 0),
      earned30d: points.earned,
      redeemed30d: points.redeemed,
      customersWithPoints: points.customers_with_points,
      customersTotal: customerRows.rows[0]?.total ?? 0,
    },
    giftCards: {
      issued30d: giftCardRows.rows[0]?.issued ?? 0,
      issuedValue30d: Number(giftCardRows.rows[0]?.value ?? 0),
      outstandingRial:
        bridge.find((row) => row.code === WELL_KNOWN_CODES.giftCardPayable)?.balance ?? 0,
    },
    commission: {
      accrued30d: commissionAccruals.reduce((sum, row) => sum + row.amount, 0),
      top: commissionAccruals.slice(0, 3),
    },
    repurchase: {
      due: repurchase.length,
      sample: repurchase.slice(0, 5),
    },
    bridge,
    activity: activityRows.rows.map((row) => ({
      at: new Date(row.at).toISOString(),
      kind: row.kind,
      subject: row.subject ?? "—",
      amount: Number(row.amount),
      sourceType: row.source_type ?? null,
    })),
  };
}
