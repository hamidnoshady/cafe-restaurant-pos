/**
 * Plan-included monthly AI credit (migration 0168) — the Plan Builder's AI limit.
 *
 * A billing plan may include a monthly AI allowance
 * (`billing_plans.monthly_ai_credit_rial`). The allowance is NOT a second
 * balance: it is a per-calendar-month cap that the wallet settlement consumes
 * FIRST, so a «Professional with ۱۰۰٬۰۰۰ تومان AI credit» plan needs no
 * manual grant and no second money table. Whatever the allowance does not
 * cover is charged to the wallet exactly as before.
 *
 * Period shape: one row per (business, calendar month) in
 * `ai_plan_allowance_usage`. The month is computed in Asia/Tehran so an
 * Iranian business's "month" flips at Iranian midnight, not UTC's. The
 * `granted_rial` column snapshots the plan's allowance at the month's first
 * use; the effective cap for the rest of the month is
 * min(granted_rial, plan's current value) — lowering a plan takes effect
 * immediately, raising it only next month, and history is never rewritten.
 */

import type { PoolClient } from "./db";
import { query, withoutTenantScope } from "./db";

/** The billing calendar: everything AI-bills in Asia/Tehran. */
export const AI_BILLING_TIME_ZONE = "Asia/Tehran";

/**
 * The `period_month` key ('YYYY-MM') for a moment, in the billing calendar.
 * Pure — the unit test shifts a moment across the Tehran midnight to prove the
 * month flip happens at the right boundary.
 */
export function periodMonthFor(date: Date, timeZone: string = AI_BILLING_TIME_ZONE): string {
  // en-CA formats as YYYY-MM-DD; the first seven characters are the key.
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return formatted.slice(0, 7);
}

/** The current period key. */
export function currentPeriodMonth(): string {
  return periodMonthFor(new Date());
}

export interface PlanAllowance {
  /** The plan's monthly AI credit right now (0 when the plan has none). */
  monthlyCreditRial: number;
  /** What has already been consumed this month. */
  usedRial: number;
  /** monthlyCreditRial - usedRial, never negative. */
  remainingRial: number;
}

const ZERO_ALLOWANCE: PlanAllowance = {
  monthlyCreditRial: 0,
  usedRial: 0,
  remainingRial: 0,
};

function toRial(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * A business's remaining plan allowance for the current month.
 * Read path only — the settlement consumes inside its own transaction via
 * `consumePlanAllowanceTx`.
 */
export async function getPlanAllowance(businessId: string): Promise<PlanAllowance> {
  return withoutTenantScope("platform", async () => readAllowance(businessId, currentPeriodMonth()));
}

async function readAllowance(businessId: string, periodMonth: string): Promise<PlanAllowance> {
  const { rows } = await query<{ monthly_credit: string | null; used: string | null }>(
    `SELECT COALESCE(
              (SELECT al.included_quantity FROM billing_plan_meter_allowances al
                WHERE al.plan_key = p.key AND al.meter_key = 'ai.credit'),
              p.monthly_ai_credit_rial
            ) AS monthly_credit,
            a.used_rial AS used
       FROM businesses b
       LEFT JOIN billing_plans p ON p.key = b.plan
       LEFT JOIN ai_plan_allowance_usage a
              ON a.business_id = b.id AND a.period_month = $2
      WHERE b.id = $1`,
    [businessId, periodMonth],
  );
  const row = rows[0];
  if (!row) return ZERO_ALLOWANCE;
  const monthlyCreditRial = toRial(row.monthly_credit);
  const usedRial = toRial(row.used);
  return {
    monthlyCreditRial,
    usedRial,
    remainingRial: Math.max(0, monthlyCreditRial - usedRial),
  };
}

/**
 * Consume up to `amountRial` of the plan allowance, INSIDE the caller's
 * wallet transaction (the wallet row is already locked; the allowance row is
 * locked the same way). Returns what was actually consumed — `amountRial`
 * itself when the allowance covers it, its remainder otherwise, and 0 when the
 * plan includes no AI credit. Never throws for "no allowance": a business on a
 * plan without AI credit simply pays from the wallet, as it always did.
 */
export async function consumePlanAllowanceTx(
  client: PoolClient,
  businessId: string,
  amountRial: number,
): Promise<number> {
  const amount = Math.max(0, Math.floor(amountRial));
  if (amount === 0) return 0;

  const periodMonth = currentPeriodMonth();

  // The plan's CURRENT allowance, and the month's snapshot row if one exists.
  // No FOR UPDATE here, and none is needed: this runs only inside the wallet
  // settlement, which already holds the per-business lock on business_wallets
  // (`withWalletTx`), so concurrent AI turns for one business serialize before
  // they can ever reach this row. (Postgres also refuses FOR UPDATE on the
  // nullable side of this outer join.)
  const plan = await client.query<{ monthly_credit: string | null; used: string | null; granted: string | null }>(
    `SELECT COALESCE(
              (SELECT al.included_quantity FROM billing_plan_meter_allowances al
                WHERE al.plan_key = p.key AND al.meter_key = 'ai.credit'),
              p.monthly_ai_credit_rial
            ) AS monthly_credit,
            a.used_rial AS used,
            a.granted_rial AS granted
       FROM businesses b
       LEFT JOIN billing_plans p ON p.key = b.plan
       LEFT JOIN ai_plan_allowance_usage a
              ON a.business_id = b.id AND a.period_month = $2
      WHERE b.id = $1`,
    [businessId, periodMonth],
  );
  const row = plan.rows[0];
  if (!row) return 0;

  const monthlyCredit = toRial(row.monthly_credit);
  const granted = toRial(row.granted);
  const used = toRial(row.used);

  if (monthlyCredit <= 0) return 0;

  if (granted <= 0) {
    // First use this month: snapshot the plan's allowance onto the row.
    await client.query(
      `INSERT INTO ai_plan_allowance_usage (business_id, period_month, granted_rial, used_rial)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (business_id, period_month) DO NOTHING`,
      [businessId, periodMonth, monthlyCredit],
    );
  }

  // Effective cap: the month's snapshot, never above the plan's current value
  // (a mid-month plan raise applies next month; a cut applies immediately).
  const effectiveCap = granted > 0 ? Math.min(granted, monthlyCredit) : monthlyCredit;
  const remaining = Math.max(0, effectiveCap - used);
  const consumed = Math.min(amount, remaining);
  if (consumed <= 0) return 0;

  await client.query(
    `INSERT INTO ai_plan_allowance_usage (business_id, period_month, granted_rial, used_rial)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, period_month)
     DO UPDATE SET used_rial = ai_plan_allowance_usage.used_rial + $4,
                   granted_rial = GREATEST(ai_plan_allowance_usage.granted_rial, EXCLUDED.granted_rial),
                   updated_at = now()`,
    [businessId, periodMonth, granted > 0 ? granted : monthlyCredit, consumed],
  );
  return consumed;
}
