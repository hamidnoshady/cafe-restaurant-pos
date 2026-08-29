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
 *   balance, reconstructed from `journal_lines` exactly as the trial balance
 *   reconstructs it — the app writes no money of its own, so the one money
 *   number it shows is borrowed from the books rather than recomputed.
 * - **Windows are rolling**, not calendar months, so a figure means the same
 *   thing on any day it is opened.
 */

import { query } from "./db";
import { businessToday } from "./business-day-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountBalance } from "./growth-shared";
import { previousWindow, rollingWindow, weightedPipelineValue, winRate, type DealStage } from "./crm-shared";
import { retentionBetween, stageDistribution, type LifecycleStage } from "./crm-scoring";
import { scoredPopulation } from "./crm-service";

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
    /** Realised lifetime spend across all customers, integer Rial. */
    totalHistoricRial: number;
    averageCustomerRial: number;
    /** The ledger's 2410 store-credit liability — the books' number, not ours. */
    storeCreditRial: number;
  };
  pipeline: {
    openCount: number;
    openValueRial: number;
    weightedValueRial: number;
    winRatePercent: number;
    byStage: { stage: DealStage; count: number; valueRial: number }[];
  };
  cases: {
    open: number;
    urgent: number;
    resolved30d: number;
    /** Median hours to resolve, over the window. Null when nothing was resolved. */
    medianResolutionHours: number | null;
  };
  tasks: { open: number; overdue: number; dueToday: number };
  segments: { total: number; names: string[] };
  topCustomers: { id: string; name: string; totalSpentRial: number; orderCount: number; stage: string }[];
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
    { rows: segmentRows },
    { rows: creditRows },
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
         FROM customers
        WHERE business_id = $1 AND merged_into_id IS NULL`,
      [businessId, window.from, window.to, prior.from, prior.to],
    ),
    query<Record<string, string>>(
      `SELECT count(*) FILTER (WHERE sms_consent)::text AS sms_granted,
              count(*) FILTER (WHERE marketing_consent)::text AS email_granted,
              count(*) FILTER (WHERE sms_consent AND phone_e164 IS NOT NULL)::text AS sms_reachable,
              count(*) FILTER (WHERE marketing_consent AND email IS NOT NULL AND btrim(email) <> '')::text AS email_reachable,
              count(*)::text AS total
         FROM customers
        WHERE business_id = $1 AND merged_into_id IS NULL`,
      [businessId],
    ),
    query<{ stage: string; count: string; value_rial: string; probability: number | null }>(
      `SELECT stage, count(*)::text AS count, coalesce(sum(value_rial), 0)::text AS value_rial,
              avg(probability)::int AS probability
         FROM crm_deals WHERE business_id = $1 GROUP BY stage`,
      [businessId],
    ),
    query<Record<string, string>>(
      `SELECT count(*) FILTER (WHERE status IN ('open', 'in_progress', 'waiting'))::text AS open,
              count(*) FILTER (WHERE status IN ('open', 'in_progress') AND priority = 'urgent')::text AS urgent,
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
      `SELECT count(*) FILTER (WHERE completed_at IS NULL)::text AS open,
              count(*) FILTER (WHERE completed_at IS NULL AND due_at IS NOT NULL
                               AND due_at::date < $2::date)::text AS overdue,
              count(*) FILTER (WHERE completed_at IS NULL AND due_at::date = $2::date)::text AS due_today
         FROM crm_activities WHERE business_id = $1`,
      [businessId, today],
    ),
    query<{ name: string }>(
      `SELECT name FROM customer_segments
        WHERE business_id = $1 AND archived_at IS NULL ORDER BY name LIMIT 20`,
      [businessId],
    ),
    // The ledger's own 2410 balance, the same reconstruction the trial balance
    // performs. The CRM posts nothing, so this number is the books' number.
    query<{ type: string; debit: string; credit: string }>(
      `SELECT a.type::text,
              coalesce(sum(jl.debit), 0)::text AS debit,
              coalesce(sum(jl.credit), 0)::text AS credit
         FROM accounts a
         LEFT JOIN journal_lines jl ON jl.account_id = a.id
        WHERE a.business_id = $1 AND a.code = $2
        GROUP BY a.type`,
      [businessId, WELL_KNOWN_CODES.storeCreditPayable],
    ),
    query<{ period: string; customer_id: string }>(
      `SELECT CASE WHEN app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)
                        BETWEEN $2::date AND $3::date
                   THEN 'current' ELSE 'prior' END AS period,
              o.customer_id
         FROM orders o
         JOIN locations l ON l.id = o.location_id
        WHERE l.business_id = $1 AND o.status = 'completed' AND o.closed_at IS NOT NULL
          AND o.customer_id IS NOT NULL
          AND app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)
              BETWEEN $4::date AND $3::date
        GROUP BY 1, 2`,
      [businessId, window.from, window.to, prior.from],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM customers a JOIN customers b
           ON b.business_id = a.business_id AND b.phone_e164 = a.phone_e164 AND a.id < b.id
        WHERE a.business_id = $1 AND a.phone_e164 IS NOT NULL
          AND a.merged_into_id IS NULL AND b.merged_into_id IS NULL`,
      [businessId],
    ),
    query<{ scored_at: string | null }>(
      `SELECT max(rfm_scored_at)::text AS scored_at FROM customers WHERE business_id = $1`,
      [businessId],
    ),
  ]);

  const scores = await scoredPopulation(businessId);
  const lifecycle = stageDistribution(scores);
  const totalHistoricRial = scores.reduce((sum, score) => sum + score.totalSpentRial, 0);

  const customer = customerRows[0] ?? {};
  const consent = consentRows[0] ?? {};
  const cases = caseRows[0] ?? {};
  const tasks = taskRows[0] ?? {};
  const n = (source: Record<string, string>, key: string) => Number(source[key] ?? 0);

  const deals = pipelineRows.map((row) => ({
    stage: row.stage as DealStage,
    count: Number(row.count),
    valueRial: Number(row.value_rial),
    probability: row.probability,
  }));
  const openDeals = deals.filter((deal) => deal.stage !== "won" && deal.stage !== "lost");

  const consentTotal = n(consent, "total");
  const storeCredit = creditRows[0]
    ? accountBalance(creditRows[0].type, Number(creditRows[0].debit), Number(creditRows[0].credit))
    : 0;

  const scoredCount = scores.length;

  return {
    window,
    customers: {
      total: n(customer, "total"),
      active: n(customer, "active"),
      new30d: n(customer, "new_window"),
      newPrevious30d: n(customer, "new_prior"),
      withPhone: n(customer, "with_phone"),
      withEmail: n(customer, "with_email"),
      neverPurchased: scores.filter((score) => score.stage === "never_purchased").length,
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
      averageCustomerRial: scoredCount === 0 ? 0 : Math.round(totalHistoricRial / scoredCount),
      storeCreditRial: storeCredit,
    },
    pipeline: {
      openCount: openDeals.reduce((sum, deal) => sum + deal.count, 0),
      openValueRial: openDeals.reduce((sum, deal) => sum + deal.valueRial, 0),
      // Weighted by each stage's probability — the honest version of "how much
      // is in the pipeline", since a first-contact lead is not a signed deal.
      weightedValueRial: weightedPipelineValue(
        deals.flatMap((deal) =>
          Array.from({ length: deal.count }, () => ({
            stage: deal.stage,
            valueRial: Math.round(deal.valueRial / Math.max(deal.count, 1)),
            probability: deal.probability,
          })),
        ),
      ),
      winRatePercent: winRate(
        deals.flatMap((deal) => Array.from({ length: deal.count }, () => ({ stage: deal.stage }))),
      ),
      byStage: deals.map(({ stage, count, valueRial }) => ({ stage, count, valueRial })),
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
    segments: { total: segmentRows.length, names: segmentRows.map((row) => row.name) },
    topCustomers: [...scores]
      .sort((a, b) => b.totalSpentRial - a.totalSpentRial)
      .slice(0, 10)
      .map((score) => ({
        id: score.customerId,
        name: score.name,
        totalSpentRial: score.totalSpentRial,
        orderCount: score.orderCount,
        stage: score.stage,
      })),
    duplicates: Number(duplicateRows[0]?.count ?? 0),
  };
}
