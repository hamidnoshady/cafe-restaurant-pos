/**
 * The CRM app's management dashboard — «میز کار مشتریان».
 *
 * The same shape the Growth app's dashboard has (`growth-overview.ts`): one
 * read-only query object that answers the owner's actual question — here
 * «مشتری‌هایم چه خبرند؟» — from the tables that already own each fact.
 *
 * Two properties this file keeps, deliberately:
 *
 * - **No number here is invented.** Purchase figures come from `orders` with
 *   the same business-day bucketing and the same completed-only rule the
 *   segments and the sales reports use, so the CRM cannot disagree with the
 *   sales report next to it. The store-credit figure is the *ledger's* 2410
 *   balance, read through Accounting's own service — the app writes no money
 *   of its own and reconstructs none, so the one money number it shows is
 *   borrowed from the books rather than recomputed.
 * - **Windows are rolling**, not calendar months, so a figure means the same
 *   thing on any day it is opened.
 */

import { query } from "./db";
import { mobileReachableSql, phonePairKeySql } from "./parties-service";
import { businessToday } from "./business-day-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { wellKnownAccountBalance } from "./ar-service";
import { previousWindow, rollingWindow, type DealStage } from "./crm-shared";
import { retentionBetween, stageDistribution, type LifecycleStage } from "./crm-scoring";
import { customerPurchasePopulation, scoredPopulation } from "./crm-service";

/**
 * How many segment *names* the overview card previews. Never the total — the
 * total is a separate uncapped count, see `CrmOverview["segments"]`.
 */
export const SEGMENT_PREVIEW_LIMIT = 20;

export interface CrmOverview {
  window: { from: string; to: string };
  customers: {
    total: number;
    active: number;
    /** Added in the window. */
    new30d: number;
    newPrevious30d: number;
    withPhone: number;
    withEmail: number;
    /** Never bought anything — the group a first-purchase campaign exists for. */
    neverPurchased: number;
  };
  consent: {
    smsGranted: number;
    emailGranted: number;
    smsReachable: number;
    emailReachable: number;
    /** Percent of customers reachable by SMS — "how much of the next phase is usable". */
    smsCoveragePercent: number;
  };
  lifecycle: { stage: LifecycleStage; count: number; valueRial: number }[];
  /** Null until the first RFM recompute has run. */
  lastScoredAt: string | null;
  retention: ReturnType<typeof retentionBetween>;
  value: {
    /** Realised lifetime spend across all customers, integer Rial as text for BigInt safety. */
    totalHistoricRial: string;
    averageCustomerRial: string;
    /** The ledger's 2410 store-credit liability — the books' number, not ours, as text for BigInt safety. */
    storeCreditRial: string;
  };
  pipeline: {
    openCount: number;
    openValueRial: string;
    weightedValueRial: string;
    winRatePercent: number;
    byStage: { stage: DealStage; count: number; valueRial: string }[];
  };
  cases: {
    open: number;
    urgent: number;
    resolved30d: number;
    /** Median hours to resolve, over the window. Null when nothing was resolved. */
    medianResolutionHours: number | null;
  };
  tasks: { open: number; overdue: number; dueToday: number };
  /**
   * `total` is every live segment (uncapped `COUNT(*)`); `names` is only the
   * handful the card prints. They are deliberately two different numbers —
   * conflating them is what made a business with 40 segments read «۲۰».
   */
  segments: { total: number; names: string[] };
  topCustomers: { id: string; name: string; totalSpentRial: string; orderCount: number; stage: string }[];
  duplicates: number;
}

export async function crmOverview(businessId: string): Promise<CrmOverview> {
  const today = await businessToday(businessId);
  const window = rollingWindow(today, 30);
  const prior = previousWindow(window);

  const [
    { rows: customerRows },
    { rows: consentRows },
    { rows: pipelineRows },
    { rows: caseRows },
    { rows: taskRows },
    { rows: segmentTotalRows },
    { rows: segmentNameRows },
    storeCreditBalance,
    { rows: retentionRows },
    { rows: duplicateRows },
    { rows: scoredAtRows },
  ] = await Promise.all([
    query<Record<string, string>>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE is_active)::text AS active,
              count(*) FILTER (WHERE created_at::date BETWEEN $2::date AND $3::date)::text AS new_window,
              count(*) FILTER (WHERE created_at::date BETWEEN $4::date AND $5::date)::text AS new_prior,
              count(*) FILTER (WHERE phone IS NOT NULL AND btrim(phone) <> '')::text AS with_phone,
              count(*) FILTER (WHERE email IS NOT NULL AND btrim(email) <> '')::text AS with_email
         FROM parties
        WHERE business_id = $1
          AND roles && ARRAY['customer']::text[]
          AND is_active
          AND merged_into_id IS NULL`,
      [businessId, window.from, window.to, prior.from, prior.to],
    ),
    query<Record<string, string>>(
      // Same "is it actually a mobile" predicate as crm-service's reachability
      // stats — a landline is not SMS-reachable, and after step 3 there is no
      // plaintext number left to notice that with.
      `SELECT count(*) FILTER (WHERE sms_consent)::text AS sms_granted,
              count(*) FILTER (WHERE marketing_consent)::text AS email_granted,
              count(*) FILTER (WHERE sms_consent AND ${mobileReachableSql()})::text AS sms_reachable,
              count(*) FILTER (WHERE marketing_consent AND email IS NOT NULL AND btrim(email) <> '')::text AS email_reachable,
              count(*)::text AS total
         FROM parties
        WHERE business_id = $1
          AND roles && ARRAY['customer']::text[]
          AND is_active
          AND merged_into_id IS NULL`,
      [businessId],
    ),
    query<{ stage: string; count: string; value_rial: string; weighted_value_rial: string }>(
      `SELECT stage, count(*)::text AS count, coalesce(sum(value_rial), 0)::text AS value_rial,
              coalesce(sum(
                CASE WHEN stage IN ('won', 'lost') THEN 0::bigint
                     ELSE round(value_rial::numeric * coalesce(probability,
                       CASE stage
                         WHEN 'lead' THEN 10
                         WHEN 'qualified' THEN 30
                         WHEN 'proposal' THEN 55
                         WHEN 'negotiation' THEN 75
                         ELSE 0
                       END
                     ) / 100)::bigint
                END
              ), 0)::text AS weighted_value_rial
         FROM crm_deals
        WHERE business_id = $1
        GROUP BY stage
        ORDER BY CASE stage
          WHEN 'lead' THEN 1 WHEN 'qualified' THEN 2 WHEN 'proposal' THEN 3
          WHEN 'negotiation' THEN 4 WHEN 'won' THEN 5 WHEN 'lost' THEN 6 ELSE 7
        END`,
      [businessId],
    ),
    query<Record<string, string>>(
      `SELECT count(*) FILTER (WHERE status IN ('open', 'in_progress', 'waiting'))::text AS open,
              count(*) FILTER (WHERE status IN ('open', 'in_progress', 'waiting') AND priority = 'urgent')::text AS urgent,
              count(*) FILTER (WHERE resolved_at IS NOT NULL
                               AND resolved_at::date BETWEEN $2::date AND $3::date)::text AS resolved_window,
              (percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (resolved_at - opened_at)) / 3600
               ) FILTER (WHERE resolved_at IS NOT NULL
                         AND resolved_at::date BETWEEN $2::date AND $3::date))::text AS median_hours
         FROM crm_cases WHERE business_id = $1`,
      [businessId, window.from, window.to],
    ),
    query<Record<string, string>>(
      `SELECT count(*) FILTER (WHERE a.completed_at IS NULL)::text AS open,
              count(*) FILTER (WHERE a.completed_at IS NULL AND a.due_at IS NOT NULL
                               AND app_business_date(a.due_at, coalesce(l.timezone, 'Asia/Tehran'), coalesce(l.business_day_start_minutes, 0)) < $2::date)::text AS overdue,
              count(*) FILTER (WHERE a.completed_at IS NULL AND a.due_at IS NOT NULL
                               AND app_business_date(a.due_at, coalesce(l.timezone, 'Asia/Tehran'), coalesce(l.business_day_start_minutes, 0)) = $2::date)::text AS due_today
         FROM crm_activities a
         LEFT JOIN LATERAL (
           SELECT timezone, business_day_start_minutes
             FROM locations
            WHERE business_id = $1 AND is_active
            ORDER BY created_at
            LIMIT 1
         ) l ON true
        WHERE a.business_id = $1`,
      [businessId, today],
    ),
    // The total and the preview names are two different questions, and they
    // must be asked separately. A single `SELECT name … LIMIT 20` whose
    // `rows.length` was then used as the total reported «۲۰ بخش‌بندی» to every
    // business that had more than twenty — the cap on the *display* list
    // silently became the cap on the *count*. The count is uncapped; only the
    // names the card prints are limited.
    query<{ total: string }>(
      `SELECT count(*)::text AS total FROM customer_segments
        WHERE business_id = $1 AND archived_at IS NULL`,
      [businessId],
    ),
    query<{ name: string }>(
      `SELECT name FROM customer_segments
        WHERE business_id = $1 AND archived_at IS NULL ORDER BY name LIMIT $2`,
      [businessId, SEGMENT_PREVIEW_LIMIT],
    ),
    // The ledger's own 2410 balance, read through Accounting's service rather
    // than reconstructed here. The CRM posts nothing and computes nothing
    // about money; the one money figure on this screen is the books' figure,
    // fetched from the app that owns it.
    wellKnownAccountBalance(businessId, WELL_KNOWN_CODES.storeCreditPayable),
    query<{ period: string; customer_id: string }>(
      `SELECT CASE WHEN app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)
                        BETWEEN $2::date AND $3::date
                   THEN 'current' ELSE 'prior' END AS period,
              o.customer_id
         FROM orders o
         JOIN locations l ON l.id = o.location_id
         JOIN parties c ON c.id = o.customer_id
        WHERE l.business_id = $1 AND c.business_id = $1
          AND c.roles && ARRAY['customer']::text[] AND c.is_active AND c.merged_into_id IS NULL
          AND o.status = 'completed' AND o.closed_at IS NOT NULL
          AND o.customer_id IS NOT NULL
          AND app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)
              BETWEEN $4::date AND $3::date
        GROUP BY 1, 2`,
      [businessId, window.from, window.to, prior.from],
    ),
    query<{ count: string }>(
      // Phase 24 Wave 3 — the same `coalesce(phone_bidx, phone_e164)` key
      // duplicateCandidates() matches on (crm-service.ts). It has to be the
      // same expression: this is the count shown beside that list, and a
      // count computed a different way from the list it labels is worse than
      // no count at all.
      `SELECT count(*)::text AS count
         FROM parties a JOIN parties b
           ON b.business_id = a.business_id
          AND ${phonePairKeySql("b")} = ${phonePairKeySql("a")}
          AND a.id < b.id
        WHERE a.business_id = $1 AND ${phonePairKeySql("a")} IS NOT NULL
          AND a.roles && ARRAY['customer']::text[] AND b.roles && ARRAY['customer']::text[]
          AND a.is_active AND b.is_active
          AND a.merged_into_id IS NULL AND b.merged_into_id IS NULL`,
      [businessId],
    ),
    query<{ scored_at: string | null }>(
      `SELECT max(rfm_scored_at)::text AS scored_at
         FROM parties
        WHERE business_id = $1
          AND roles && ARRAY['customer']::text[]
          AND is_active
          AND merged_into_id IS NULL`,
      [businessId],
    ),
  ]);

  const [scores, purchases] = await Promise.all([
    scoredPopulation(businessId),
    customerPurchasePopulation(businessId),
  ]);
  const lifecycle = stageDistribution(scores);
  const scoreByCustomer = new Map(scores.map((score) => [score.customerId, score]));
  const totalHistoricRial = purchases
    .reduce((sum, customer) => sum + BigInt(customer.totalSpentRial), 0n)
    .toString();

  const customer = customerRows[0] ?? {};
  const consent = consentRows[0] ?? {};
  const cases = caseRows[0] ?? {};
  const tasks = taskRows[0] ?? {};
  const n = (source: Record<string, string>, key: string) => Number(source[key] ?? 0);

  const deals = pipelineRows.map((row) => ({
    stage: row.stage as DealStage,
    count: Number(row.count),
    valueRial: row.value_rial,
    weightedValueRial: row.weighted_value_rial,
  }));
  const openDeals = deals.filter((deal) => deal.stage !== "won" && deal.stage !== "lost");

  const consentTotal = n(consent, "total");
  // null means the business has no chart of accounts yet, which shows as zero
  // credit outstanding — there are no store-credit liabilities if there is no
  // ledger to record them in.
  const storeCredit = String(storeCreditBalance ?? 0);

  const customerCount = purchases.length;
  const sumBigInt = (values: string[]) => values.reduce((sum, value) => sum + BigInt(value), 0n).toString();

  return {
    window,
    customers: {
      total: n(customer, "total"),
      active: n(customer, "active"),
      new30d: n(customer, "new_window"),
      newPrevious30d: n(customer, "new_prior"),
      withPhone: n(customer, "with_phone"),
      withEmail: n(customer, "with_email"),
      neverPurchased: purchases.filter((customer) => customer.orderCount === 0).length,
    },
    consent: {
      smsGranted: n(consent, "sms_granted"),
      emailGranted: n(consent, "email_granted"),
      smsReachable: n(consent, "sms_reachable"),
      emailReachable: n(consent, "email_reachable"),
      smsCoveragePercent:
        consentTotal === 0 ? 0 : Math.round((n(consent, "sms_reachable") / consentTotal) * 1000) / 10,
    },
    lifecycle,
    lastScoredAt: scoredAtRows[0]?.scored_at ?? null,
    retention: retentionBetween({
      priorCustomerIds: retentionRows.filter((row) => row.period === "prior").map((row) => row.customer_id),
      currentCustomerIds: retentionRows.filter((row) => row.period === "current").map((row) => row.customer_id),
    }),
    value: {
      totalHistoricRial,
      averageCustomerRial:
        customerCount === 0
          ? "0"
          : ((BigInt(totalHistoricRial) + BigInt(customerCount) / 2n) / BigInt(customerCount)).toString(),
      storeCreditRial: storeCredit,
    },
    pipeline: {
      openCount: openDeals.reduce((sum, deal) => sum + deal.count, 0),
      openValueRial: sumBigInt(openDeals.map((deal) => deal.valueRial)),
      // Weighted in SQL from every deal's own probability. Expanding grouped
      // counts into one JS object per deal made a large pipeline a browser/server
      // memory hazard and rounded different probabilities into one average.
      weightedValueRial: sumBigInt(openDeals.map((deal) => deal.weightedValueRial)),
      winRatePercent: (() => {
        const decided = deals.filter((deal) => deal.stage === "won" || deal.stage === "lost");
        const decidedCount = decided.reduce((sum, deal) => sum + deal.count, 0);
        const wonCount = decided
          .filter((deal) => deal.stage === "won")
          .reduce((sum, deal) => sum + deal.count, 0);
        return decidedCount === 0 ? 0 : Math.round((wonCount / decidedCount) * 1000) / 10;
      })(),
      byStage: openDeals.map(({ stage, count, valueRial }) => ({ stage, count, valueRial })),
    },
    cases: {
      open: n(cases, "open"),
      urgent: n(cases, "urgent"),
      resolved30d: n(cases, "resolved_window"),
      medianResolutionHours: cases.median_hours ? Math.round(Number(cases.median_hours) * 10) / 10 : null,
    },
    tasks: {
      open: n(tasks, "open"),
      overdue: n(tasks, "overdue"),
      dueToday: n(tasks, "due_today"),
    },
    segments: {
      total: Number(segmentTotalRows[0]?.total ?? 0),
      names: segmentNameRows.map((row) => row.name),
    },
    topCustomers: [...purchases]
      .sort((a, b) => {
        const difference = BigInt(b.totalSpentRial) - BigInt(a.totalSpentRial);
        return difference === 0n ? a.name.localeCompare(b.name) : difference > 0n ? 1 : -1;
      })
      .slice(0, 10)
      .map((customer) => ({
        id: customer.customerId,
        name: customer.name,
        totalSpentRial: customer.totalSpentRial,
        orderCount: customer.orderCount,
        stage: scoreByCustomer.get(customer.customerId)?.stage ?? "unscored",
      })),
    duplicates: Number(duplicateRows[0]?.count ?? 0),
  };
}
