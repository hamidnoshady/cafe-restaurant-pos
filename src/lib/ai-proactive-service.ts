/**
 * Phase 18b Wave 4 — tenant-safe proactive assistant jobs.
 *
 * This is intentionally a service, not a route: server.ts invokes it outside
 * requests. It discovers business ids under the documented platform bypass,
 * then re-enters every business with withTenant before it reads facts, creates
 * a run record, creates a credit reservation or writes a draft. No scheduled
 * work is allowed to use the bypass after discovery.
 */
import {
  AI_PROACTIVE_TICK_INTERVAL_MS as PROACTIVE_TICK_INTERVAL_MS,
  DEFAULT_AI_PROACTIVE_SETTINGS,
  DEFAULT_PROACTIVE_TIMEZONE,
  compactProactiveFacts,
  debtFollowUpDraft,
  dueProactiveRuns,
  localBusinessClock,
  proactivePeriodKey,
  shiftIsoDate,
  type AiProactiveRunKind,
  type AiProactiveSettings,
  type LocalBusinessClock,
} from "./ai-proactive";
import { getPlatformAiConfig, isPlatformAiConfigured, type PlatformAiConfig } from "./ai-config";
import {
  AiInsufficientCreditError,
  cancelAiTurnReservation,
  reserveAiTurn,
  settleAiTurn,
  type AiTurnReservation,
} from "./ai-billing-service";
import { runAgentTurn } from "./ai-service";
import { runReadTool } from "./ai-tools";
import { listCustomerBalances, UNKNOWN_CUSTOMER_KEY } from "./ar-service";
import { query, withTenant, withoutTenantScope } from "./db";
import { isFeatureEnabled } from "./features";

export const AI_PROACTIVE_TICK_INTERVAL_MS = PROACTIVE_TICK_INTERVAL_MS;

type RunStatus = "running" | "completed" | "skipped" | "failed";

export interface AiProactiveOverview {
  enabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: Exclude<RunStatus, "running"> | null;
  draftCount: number;
}

interface RunClaim {
  id: string;
  periodKey: string;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function validHour(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 23;
}

async function businessTimezone(businessId: string): Promise<string> {
  const { rows } = await query<{ timezone: string | null }>(
    `SELECT timezone
       FROM locations
      WHERE business_id = $1 AND is_active
      ORDER BY created_at
      LIMIT 1`,
    [businessId],
  );
  return rows[0]?.timezone || DEFAULT_PROACTIVE_TIMEZONE;
}

async function businessName(businessId: string): Promise<string | null> {
  const { rows } = await query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [businessId]);
  return rows[0]?.name ?? null;
}

/** Background processing is deliberately opt-in because it can consume credits unattended. */
export async function getAiProactiveSettings(businessId: string): Promise<AiProactiveSettings> {
  const { rows } = await query<{ enabled: boolean; daily_digest_hour: number; weekly_digest_weekday: number }>(
    `SELECT enabled, daily_digest_hour, weekly_digest_weekday
       FROM ai_proactive_settings
      WHERE business_id = $1`,
    [businessId],
  );
  const row = rows[0];
  if (!row) return { ...DEFAULT_AI_PROACTIVE_SETTINGS };
  return {
    enabled: row.enabled,
    dailyDigestHour: validHour(row.daily_digest_hour)
      ? row.daily_digest_hour
      : DEFAULT_AI_PROACTIVE_SETTINGS.dailyDigestHour,
    weeklyDigestWeekday:
      Number.isInteger(row.weekly_digest_weekday) && row.weekly_digest_weekday >= 0 && row.weekly_digest_weekday <= 6
        ? row.weekly_digest_weekday
        : DEFAULT_AI_PROACTIVE_SETTINGS.weeklyDigestWeekday,
  };
}

export async function setAiProactiveEnabled(businessId: string, enabled: boolean): Promise<AiProactiveSettings> {
  if (typeof enabled !== "boolean") throw new Error("invalid_proactive_enabled");
  await query(
    `INSERT INTO ai_proactive_settings (business_id, enabled, daily_digest_hour, weekly_digest_weekday)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id)
     DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [
      businessId,
      enabled,
      DEFAULT_AI_PROACTIVE_SETTINGS.dailyDigestHour,
      DEFAULT_AI_PROACTIVE_SETTINGS.weeklyDigestWeekday,
    ],
  );
  return getAiProactiveSettings(businessId);
}

export async function getAiProactiveOverview(businessId: string): Promise<AiProactiveOverview> {
  const [settings, lastRun, drafts] = await Promise.all([
    getAiProactiveSettings(businessId),
    query<{ finished_at: Date | null; status: RunStatus }>(
      `SELECT finished_at, status
         FROM ai_proactive_runs
        WHERE business_id = $1 AND status <> 'running'
        ORDER BY finished_at DESC NULLS LAST, started_at DESC
        LIMIT 1`,
      [businessId],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM ai_proactive_drafts
        WHERE business_id = $1 AND status = 'draft'`,
      [businessId],
    ),
  ]);
  const row = lastRun.rows[0];
  return {
    enabled: settings.enabled,
    lastRunAt: row?.finished_at?.toISOString() ?? null,
    lastRunStatus: row && row.status !== "running" ? row.status : null,
    draftCount: Number(drafts.rows[0]?.count ?? 0),
  };
}

async function claimRun(
  businessId: string,
  kind: AiProactiveRunKind,
  periodKey: string,
): Promise<RunClaim | null> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO ai_proactive_runs (business_id, kind, period_key, status)
     VALUES ($1, $2, $3, 'running')
     ON CONFLICT (business_id, kind, period_key) DO NOTHING
     RETURNING id`,
    [businessId, kind, periodKey],
  );
  return rows[0] ? { id: rows[0].id, periodKey } : null;
}

async function finishRun(input: {
  businessId: string;
  runId: string;
  status: Exclude<RunStatus, "running">;
  content?: string | null;
  facts?: unknown;
  creditRequestId?: string | null;
  error?: string | null;
}): Promise<void> {
  await query(
    `UPDATE ai_proactive_runs
        SET status = $3,
            content = $4,
            facts = COALESCE($5::jsonb, facts),
            credit_request_id = COALESCE($6, credit_request_id),
            error = $7,
            finished_at = now()
      WHERE id = $1 AND business_id = $2`,
    [
      input.runId,
      input.businessId,
      input.status,
      input.content?.slice(0, 12_000) ?? null,
      input.facts === undefined ? null : JSON.stringify(compactProactiveFacts(input.facts)),
      input.creditRequestId ?? null,
      input.error?.slice(0, 1000) ?? null,
    ],
  );
}

function boundedPromptFacts(facts: unknown): string {
  return JSON.stringify(compactProactiveFacts(facts)).slice(0, 42_000);
}

function digestPrompt(kind: "daily_digest" | "weekly_digest", clock: LocalBusinessClock, facts: unknown): string {
  const range = kind === "daily_digest" ? "روزانه" : "هفتگی";
  return [
    `برای مدیر یک گزارش عملیاتی خصوصی و ${range} به زبان فارسی تهیه کن. تاریخ محلی کسب‌وکار: ${clock.dateKey}.`,
    "فقط بر پایهٔ دادهٔ JSON زیر بنویس؛ اگر داده‌ای برای نتیجه‌گیری کافی نیست، همان محدودیت را صریح بگو و عددی نساز.",
    "گزارش را کوتاه و عملیاتی با تیترهای «خلاصه»، «هشدارها و پیگیری‌ها» و «اقدام پیشنهادی برای بررسی» بنویس.",
    "در صورت وجود داده، این موارد را پوشش بده: تغییر غیرعادی ابطال/تخفیف، آیتم‌های با حاشیهٔ ناخالص منفی بر پایهٔ هزینهٔ موادِ دستور ثبت‌شده، موجودی زیر نقطه سفارش، تطبیق پایان شیفت، مالیات ارزش افزوده، ردیف‌های بانکی تطبیق‌نشده، حقوق، اختلاف شعب، ارسال‌های بیش از ۶۰ دقیقه در مسیر و رزروهای بیش از ۱۵ دقیقه از زمان خود که هنوز booked هستند.",
    "برای مالیات فقط یادآوری بررسی و اقدام بده؛ بدون سیاست/تاریخ ثبت‌شده، مهلت قانونی یا رقم بدهی را قطعی اعلام نکن.",
    "هیچ اقدامی را انجام‌شده یا ارسال‌شده جلوه نده، هیچ پیام مشتری ننویس، هیچ دادهٔ جدیدی اختراع نکن و هیچ پیشنهاد اجرایی/دستور API تولید نکن.",
    "داده‌های ورودی:\n" + boundedPromptFacts(facts),
  ].join("\n\n");
}

async function collectDigestFacts(businessId: string, clock: LocalBusinessClock, kind: "daily_digest" | "weekly_digest") {
  const days = kind === "daily_digest" ? 7 : 28;
  const dateFrom = shiftIsoDate(clock.dateKey, -(days - 1));
  const priorFrom = shiftIsoDate(dateFrom, -days);
  const priorTo = shiftIsoDate(dateFrom, -1);

  const [
    sales,
    tillReconciliation,
    menuPerformance,
    voidPattern,
    stockValuation,
    bankLines,
    vat,
    payroll,
    branchComparison,
    courierPerformance,
    anomalyRows,
    lowStockRows,
    negativeMarginRows,
    lateDeliveryRows,
    noShowRows,
  ] = await Promise.all([
    runReadTool("run_report", { key: "daily_sales_summary", dateFrom, dateTo: clock.dateKey }, businessId),
    runReadTool("run_report", { key: "shift_reconciliation", dateFrom, dateTo: clock.dateKey }, businessId),
    runReadTool("get_menu_performance", { dateFrom, dateTo: clock.dateKey }, businessId),
    runReadTool("get_void_pattern", { dateFrom, dateTo: clock.dateKey }, businessId),
    runReadTool("get_stock_valuation", {}, businessId),
    runReadTool("get_unreconciled_bank_lines", {}, businessId),
    runReadTool("get_vat_liability", { dateFrom, dateTo: clock.dateKey }, businessId),
    runReadTool("get_payroll_summary", {}, businessId),
    runReadTool("get_branch_comparison", { dateFrom, dateTo: clock.dateKey }, businessId),
    runReadTool("get_courier_performance", { dateFrom, dateTo: clock.dateKey }, businessId),
    query<{
      current_void_count: string;
      previous_void_count: string;
      current_discount_rial: string;
      previous_discount_rial: string;
    }>(
      `SELECT
          (count(*) FILTER (WHERE o.status = 'voided' AND o.opened_at >= $2::timestamptz))::text AS current_void_count,
          (count(*) FILTER (WHERE o.status = 'voided' AND o.opened_at >= $3::timestamptz AND o.opened_at <= $4::timestamptz))::text AS previous_void_count,
          coalesce(sum(o.discount) FILTER (WHERE o.status = 'completed' AND o.closed_at >= $2::timestamptz), 0)::text AS current_discount_rial,
          coalesce(sum(o.discount) FILTER (WHERE o.status = 'completed' AND o.closed_at >= $3::timestamptz AND o.closed_at <= $4::timestamptz), 0)::text AS previous_discount_rial
         FROM orders o
         JOIN locations l ON l.id = o.location_id
        WHERE l.business_id = $1`,
      [businessId, `${dateFrom}T00:00:00.000Z`, `${priorFrom}T00:00:00.000Z`, `${priorTo}T23:59:59.999Z`],
    ),
    query<{
      id: string;
      name: string;
      unit: string;
      stock_qty: string;
      reorder_level: string;
    }>(
      `WITH stock AS (
         SELECT i.id, i.name, i.unit, i.reorder_level,
                coalesce(sum(m.quantity), 0) AS stock_qty
           FROM inventory_items i
           LEFT JOIN stock_movements m ON m.inventory_item_id = i.id
           JOIN locations l ON l.id = i.location_id
          WHERE l.business_id = $1 AND i.is_active AND i.reorder_level IS NOT NULL
          GROUP BY i.id, i.name, i.unit, i.reorder_level
       )
       SELECT id, name, unit, stock_qty::text, reorder_level::text
         FROM stock
        WHERE stock_qty <= reorder_level
        ORDER BY stock_qty ASC, name ASC
        LIMIT 30`,
      [businessId],
    ),
    query<{
      menu_item_id: string;
      name: string;
      current_price_rial: string;
      material_cost_rial: string;
      gross_margin_rial: string;
    }>(
      `SELECT mi.id AS menu_item_id, mi.name,
              mi.price::text AS current_price_rial,
              round(sum(ingredient.quantity * inventory.avg_cost))::text AS material_cost_rial,
              (mi.price - round(sum(ingredient.quantity * inventory.avg_cost)))::text AS gross_margin_rial
         FROM menu_items mi
         JOIN locations l ON l.id = mi.location_id
         JOIN menu_item_ingredients ingredient ON ingredient.menu_item_id = mi.id
         JOIN inventory_items inventory ON inventory.id = ingredient.inventory_item_id
        WHERE l.business_id = $1 AND mi.is_active
        GROUP BY mi.id, mi.name, mi.price
       HAVING round(sum(ingredient.quantity * inventory.avg_cost)) > mi.price
        ORDER BY (mi.price - round(sum(ingredient.quantity * inventory.avg_cost))) ASC, mi.name ASC
        LIMIT 30`,
      [businessId],
    ),
    query<{
      delivery_id: string;
      order_number: string;
      courier_name: string | null;
      dispatched_at: string;
      minutes_in_transit: string;
    }>(
      `SELECT d.id AS delivery_id, o.order_number::text, c.name AS courier_name,
              d.dispatched_at::text,
              floor(extract(epoch FROM (now() - d.dispatched_at)) / 60)::text AS minutes_in_transit
         FROM deliveries d
         JOIN orders o ON o.id = d.order_id
         JOIN locations l ON l.id = d.location_id
         LEFT JOIN couriers c ON c.id = d.courier_id
        WHERE l.business_id = $1
          AND d.status = 'out_for_delivery'
          AND d.dispatched_at <= now() - interval '60 minutes'
        ORDER BY d.dispatched_at
        LIMIT 30`,
      [businessId],
    ),
    query<{
      reservation_id: string;
      table_name: string | null;
      reserved_at: string;
      minutes_overdue: string;
    }>(
      `SELECT r.id AS reservation_id, t.name AS table_name, r.reserved_at::text,
              floor(extract(epoch FROM (now() - r.reserved_at)) / 60)::text AS minutes_overdue
         FROM reservations r
         JOIN locations l ON l.id = r.location_id
         LEFT JOIN dining_tables t ON t.id = r.table_id
        WHERE l.business_id = $1
          AND r.status = 'booked'
          AND r.reserved_at <= now() - interval '15 minutes'
          AND r.reserved_at >= now() - interval '24 hours'
        ORDER BY r.reserved_at
        LIMIT 30`,
      [businessId],
    ),
  ]);

  return compactProactiveFacts({
    period: { kind, dateFrom, dateTo: clock.dateKey, priorFrom, priorTo },
    sales: sales.data,
    tillReconciliation: tillReconciliation.data,
    menuPerformance: menuPerformance.data,
    voidPattern: voidPattern.data,
    stockValuation: stockValuation.data,
    unreconciledBankLines: bankLines.data,
    vatLiability: vat.data,
    payroll: payroll.data,
    branchComparison: branchComparison.data,
    courierPerformance: courierPerformance.data,
    voidAndDiscountComparison: anomalyRows.rows[0] ?? null,
    lowStock: lowStockRows.rows,
    negativeMarginItems: negativeMarginRows.rows,
    deliveriesOverSixtyMinutes: lateDeliveryRows.rows,
    potentialNoShows: noShowRows.rows,
  });
}

async function runDigest(input: {
  businessId: string;
  kind: "daily_digest" | "weekly_digest";
  clock: LocalBusinessClock;
  config: PlatformAiConfig;
}): Promise<boolean> {
  const claim = await claimRun(input.businessId, input.kind, proactivePeriodKey(input.kind, input.clock));
  if (!claim) return false;

  let reservation: AiTurnReservation | null = null;
  let facts: unknown;
  try {
    facts = await collectDigestFacts(input.businessId, input.clock, input.kind);
    try {
      reservation = await reserveAiTurn({
        businessId: input.businessId,
        reservedRial: input.config.maxTurnRial,
        userId: null,
        metadata: { source: "proactive", kind: input.kind, periodKey: claim.periodKey },
      });
    } catch (error) {
      if (error instanceof AiInsufficientCreditError) {
        await finishRun({
          businessId: input.businessId,
          runId: claim.id,
          status: "skipped",
          facts,
          error: "ai_credit_required",
        });
        return false;
      }
      throw error;
    }

    const reply = await runAgentTurn({
      config: input.config,
      mode: "proactive",
      businessId: input.businessId,
      promptContext: { mode: "proactive", businessName: await businessName(input.businessId) },
      messages: [{ role: "user", content: digestPrompt(input.kind, input.clock, facts) }],
    });
    const activeReservation = reservation;
    if (!activeReservation) throw new Error("ai_reservation_not_created");
    await settleAiTurn({
      businessId: input.businessId,
      reservation: activeReservation,
      usage: reply.usage,
      inputTokenRialPerMillion: input.config.inputTokenRialPerMillion,
      outputTokenRialPerMillion: input.config.outputTokenRialPerMillion,
    });
    await finishRun({
      businessId: input.businessId,
      runId: claim.id,
      status: "completed",
      content: reply.content,
      facts,
      creditRequestId: activeReservation.requestId,
    });
    return true;
  } catch (error) {
    if (reservation) {
      await cancelAiTurnReservation({
        businessId: input.businessId,
        reservation,
        reason: errorText(error),
      }).catch((cancelError) => console.error("proactive AI credit reservation refund failed", cancelError));
    }
    await finishRun({
      businessId: input.businessId,
      runId: claim.id,
      status: "failed",
      facts,
      error: errorText(error),
    }).catch((finishError) => console.error("proactive AI run could not be marked failed", finishError));
    throw error;
  }
}

/**
 * Drafts remain in the tenant database and deliberately do not send a phone,
 * contact or customer data to the AI provider. Wave 5 can surface them for a
 * human to copy, edit or discard; this wave never creates a sending channel.
 */
async function runDebtDrafts(businessId: string, clock: LocalBusinessClock): Promise<boolean> {
  const kind: AiProactiveRunKind = "customer_debt_drafts";
  const claim = await claimRun(businessId, kind, proactivePeriodKey(kind, clock));
  if (!claim) return false;
  try {
    const balances = await listCustomerBalances(businessId);
    const eligible = balances
      .filter((row) => row.customerId !== UNKNOWN_CUSTOMER_KEY && row.balance > 0)
      .slice(0, 20);
    let created = 0;
    for (const balance of eligible) {
      const { rowCount } = await query(
        `INSERT INTO ai_proactive_drafts
           (business_id, kind, customer_id, customer_name, amount_rial, period_key, content)
         VALUES ($1, 'customer_debt_follow_up', $2, $3, $4, $5, $6)
         ON CONFLICT (business_id, kind, customer_id, period_key) DO NOTHING`,
        [
          businessId,
          balance.customerId,
          balance.customerName,
          balance.balance,
          claim.periodKey,
          debtFollowUpDraft(balance.customerName, balance.balance),
        ],
      );
      if ((rowCount ?? 0) > 0) created += 1;
    }
    await finishRun({
      businessId,
      runId: claim.id,
      status: "completed",
      content: created > 0 ? `${created} پیش‌نویس پیگیری بدهی ایجاد شد؛ هیچ پیامی ارسال نشده است.` : "مشتری بدهکار قابل‌پیگیری برای پیش‌نویس وجود ندارد.",
      facts: { eligibleCustomers: eligible.length, createdDrafts: created, autoSent: false },
    });
    return created > 0;
  } catch (error) {
    await finishRun({
      businessId,
      runId: claim.id,
      status: "failed",
      error: errorText(error),
    }).catch((finishError) => console.error("proactive debt draft run could not be marked failed", finishError));
    throw error;
  }
}

async function runBusinessProactiveJobs(
  businessId: string,
  now: Date,
  aiConfig: PlatformAiConfig | null,
): Promise<number> {
  if (!(await isFeatureEnabled(businessId, "ai_assistant"))) return 0;
  const settings = await getAiProactiveSettings(businessId);
  const timezone = await businessTimezone(businessId);
  const clock = localBusinessClock(now, timezone);
  const due = dueProactiveRuns(settings, clock);
  let completed = 0;

  for (const kind of due) {
    try {
      if (kind === "customer_debt_drafts") {
        if (await runDebtDrafts(businessId, clock)) completed += 1;
        continue;
      }
      if (!aiConfig) continue;
      if (await runDigest({ businessId, kind, clock, config: aiConfig })) completed += 1;
    } catch (error) {
      // A provider or one report may fail independently; it must not prevent
      // this tenant's other scheduled work (or the next tenant) from running.
      console.error(`proactive AI ${kind} run failed for business ${businessId}:`, errorText(error));
    }
  }
  return completed;
}

/**
 * Isolates the background loop from DB plumbing so the test can prove every
 * business runs inside its own withTenant callback and one failure does not
 * break the next tenant's work.
 */
export async function runTenantScopedProactiveJobs(
  businessIds: string[],
  runInTenant: (businessId: string, work: () => Promise<void>) => Promise<void>,
  runBusiness: (businessId: string) => Promise<void>,
): Promise<{ completed: number; failed: number }> {
  let completed = 0;
  let failed = 0;
  for (const businessId of businessIds) {
    try {
      await runInTenant(businessId, async () => {
        await runBusiness(businessId);
      });
      completed += 1;
    } catch (error) {
      failed += 1;
      console.error(`proactive AI tick failed for business ${businessId}:`, errorText(error));
    }
  }
  return { completed, failed };
}

let proactiveTickInFlight = false;

/**
 * Timer entry point for server.ts. The only bypass is the narrow discovery
 * query; every tenant's facts, draft rows and AI credit ledger writes happen
 * after re-entering withTenant, so Postgres RLS remains the final boundary.
 */
export async function runAiProactiveTick(now = new Date()): Promise<number> {
  if (proactiveTickInFlight) return 0;
  proactiveTickInFlight = true;
  try {
    const [aiConfig, businessIds] = await Promise.all([
      getPlatformAiConfig(),
      withoutTenantScope("platform", async () => {
        const { rows } = await query<{ id: string }>("SELECT id FROM businesses ORDER BY id");
        return rows.map((row) => row.id);
      }),
    ]);
    const configuredAi = isPlatformAiConfigured(aiConfig) ? aiConfig : null;
    let jobsCompleted = 0;
    await runTenantScopedProactiveJobs(businessIds, withTenant, async (businessId) => {
      jobsCompleted += await runBusinessProactiveJobs(businessId, now, configuredAi);
    });
    return jobsCompleted;
  } finally {
    proactiveTickInFlight = false;
  }
}
