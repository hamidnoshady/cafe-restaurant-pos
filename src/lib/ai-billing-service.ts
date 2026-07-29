/**
 * Phase 18 — database operations for platform-owned AI credits and billing.
 *
 * The three business-owned tables are always accessed in the current tenant
 * scope, except for explicit platform-administration operations that name one
 * business ID. Every balance mutation is a row-locked transaction so two
 * concurrent assistant turns cannot spend the same credits.
 */
import { randomUUID } from "node:crypto";
import { getPool, query, withTenant, withoutTenantScope, type PoolClient } from "./db";
import {
  calculateAiUsageCostRial,
  type AiTokenUsage,
} from "./ai-billing";

/** Hourly is sufficient for monthly renewals and avoids a noisy idle tick. */
export const AI_SUBSCRIPTION_TICK_INTERVAL_MS = 60 * 60 * 1000;

type LedgerKind =
  | "manual_grant"
  | "top_up"
  | "subscription"
  | "usage"
  | "usage_refund"
  | "usage_cancelled";

export interface AiCreditPackage {
  id: string;
  name: string;
  priceRial: number;
  creditAmountRial: number;
  isActive: boolean;
  sortOrder: number;
}

export interface AiSubscriptionPlan {
  id: string;
  name: string;
  priceRial: number;
  monthlyCreditRial: number;
  isActive: boolean;
  sortOrder: number;
}

export interface AiBusinessBilling {
  balanceRial: number;
  subscriptionPlan: { id: string; name: string; monthlyCreditRial: number } | null;
  subscriptionRenewsAt: string | null;
}

export interface AiLedgerEntry {
  id: string;
  kind: LedgerKind;
  amountRial: number;
  actualCostRial: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  note: string | null;
  createdAt: string;
}

export interface AiTopUpRequest {
  id: string;
  businessId: string;
  businessName: string | null;
  packageId: string | null;
  packageName: string;
  priceRial: number;
  creditAmountRial: number;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  reviewedAt: string | null;
  createdAt: string;
}

export interface AiPlatformBusiness {
  businessId: string;
  businessName: string;
  businessStatus: string;
  balanceRial: number;
  subscriptionPlanId: string | null;
  subscriptionPlanName: string | null;
  subscriptionRenewsAt: string | null;
  usageRialLast30Days: number;
  pendingTopUps: number;
}

export interface AiTurnReservation {
  requestId: string;
  reservedRial: number;
}

export class AiInsufficientCreditError extends Error {
  constructor() {
    super("ai_credit_required");
  }
}

export class AiTopUpStateError extends Error {
  constructor() {
    super("top_up_not_pending");
  }
}

function numberValue(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function packageFromRow(row: {
  id: string;
  name: string;
  price_rial: string | number;
  credit_amount_rial: string | number;
  is_active: boolean;
  sort_order: number;
}): AiCreditPackage {
  return {
    id: row.id,
    name: row.name,
    priceRial: numberValue(row.price_rial),
    creditAmountRial: numberValue(row.credit_amount_rial),
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}

function subscriptionFromRow(row: {
  id: string;
  name: string;
  price_rial: string | number;
  monthly_credit_rial: string | number;
  is_active: boolean;
  sort_order: number;
}): AiSubscriptionPlan {
  return {
    id: row.id,
    name: row.name,
    priceRial: numberValue(row.price_rial),
    monthlyCreditRial: numberValue(row.monthly_credit_rial),
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}

export async function listAiCreditPackages(options: { activeOnly?: boolean } = {}): Promise<AiCreditPackage[]> {
  const { rows } = await query<{
    id: string;
    name: string;
    price_rial: string;
    credit_amount_rial: string;
    is_active: boolean;
    sort_order: number;
  }>(
    `SELECT id, name, price_rial, credit_amount_rial, is_active, sort_order
       FROM ai_credit_packages
      WHERE ($1::boolean = false OR is_active)
      ORDER BY sort_order, created_at, id`,
    [options.activeOnly ?? false],
  );
  return rows.map(packageFromRow);
}

export async function listAiSubscriptionPlans(
  options: { activeOnly?: boolean } = {},
): Promise<AiSubscriptionPlan[]> {
  const { rows } = await query<{
    id: string;
    name: string;
    price_rial: string;
    monthly_credit_rial: string;
    is_active: boolean;
    sort_order: number;
  }>(
    `SELECT id, name, price_rial, monthly_credit_rial, is_active, sort_order
       FROM ai_subscription_plans
      WHERE ($1::boolean = false OR is_active)
      ORDER BY sort_order, created_at, id`,
    [options.activeOnly ?? false],
  );
  return rows.map(subscriptionFromRow);
}

export async function saveAiCreditPackage(input: {
  id?: string;
  name: string;
  priceRial: number;
  creditAmountRial: number;
  isActive: boolean;
  sortOrder: number;
}): Promise<AiCreditPackage> {
  const name = input.name.trim();
  if (!name || !positiveInteger(input.priceRial) || !positiveInteger(input.creditAmountRial)) {
    throw new Error("invalid_ai_catalogue");
  }
  const sortOrder = Number.isSafeInteger(input.sortOrder) ? input.sortOrder : 0;
  const { rows } = await query<{
    id: string;
    name: string;
    price_rial: string;
    credit_amount_rial: string;
    is_active: boolean;
    sort_order: number;
  }>(
    input.id
      ? `UPDATE ai_credit_packages
            SET name = $2, price_rial = $3, credit_amount_rial = $4,
                is_active = $5, sort_order = $6, updated_at = now()
          WHERE id = $1
          RETURNING id, name, price_rial, credit_amount_rial, is_active, sort_order`
      : `INSERT INTO ai_credit_packages
           (name, price_rial, credit_amount_rial, is_active, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, price_rial, credit_amount_rial, is_active, sort_order`,
    input.id
      ? [input.id, name, input.priceRial, input.creditAmountRial, input.isActive, sortOrder]
      : [name, input.priceRial, input.creditAmountRial, input.isActive, sortOrder],
  );
  if (!rows[0]) throw new Error("not_found");
  return packageFromRow(rows[0]);
}

export async function saveAiSubscriptionPlan(input: {
  id?: string;
  name: string;
  priceRial: number;
  monthlyCreditRial: number;
  isActive: boolean;
  sortOrder: number;
}): Promise<AiSubscriptionPlan> {
  const name = input.name.trim();
  if (!name || !positiveInteger(input.priceRial) || !positiveInteger(input.monthlyCreditRial)) {
    throw new Error("invalid_ai_catalogue");
  }
  const sortOrder = Number.isSafeInteger(input.sortOrder) ? input.sortOrder : 0;
  const { rows } = await query<{
    id: string;
    name: string;
    price_rial: string;
    monthly_credit_rial: string;
    is_active: boolean;
    sort_order: number;
  }>(
    input.id
      ? `UPDATE ai_subscription_plans
            SET name = $2, price_rial = $3, monthly_credit_rial = $4,
                is_active = $5, sort_order = $6, updated_at = now()
          WHERE id = $1
          RETURNING id, name, price_rial, monthly_credit_rial, is_active, sort_order`
      : `INSERT INTO ai_subscription_plans
           (name, price_rial, monthly_credit_rial, is_active, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, price_rial, monthly_credit_rial, is_active, sort_order`,
    input.id
      ? [input.id, name, input.priceRial, input.monthlyCreditRial, input.isActive, sortOrder]
      : [name, input.priceRial, input.monthlyCreditRial, input.isActive, sortOrder],
  );
  if (!rows[0]) throw new Error("not_found");
  return subscriptionFromRow(rows[0]);
}

export async function getAiBusinessBilling(businessId: string): Promise<AiBusinessBilling> {
  const { rows } = await query<{
    balance_rial: string | null;
    subscription_id: string | null;
    subscription_name: string | null;
    monthly_credit_rial: string | null;
    subscription_renews_at: string | null;
  }>(
    `SELECT bb.balance_rial,
            sp.id AS subscription_id,
            sp.name AS subscription_name,
            sp.monthly_credit_rial,
            bb.subscription_renews_at
       FROM businesses b
       LEFT JOIN ai_business_billing bb ON bb.business_id = b.id
       LEFT JOIN ai_subscription_plans sp ON sp.id = bb.subscription_plan_id
      WHERE b.id = $1`,
    [businessId],
  );
  const row = rows[0];
  return {
    balanceRial: numberValue(row?.balance_rial),
    subscriptionPlan:
      row?.subscription_id && row.subscription_name
        ? {
            id: row.subscription_id,
            name: row.subscription_name,
            monthlyCreditRial: numberValue(row.monthly_credit_rial),
          }
        : null,
    subscriptionRenewsAt: row?.subscription_renews_at ?? null,
  };
}

export async function listRecentAiLedger(businessId: string, limit = 20): Promise<AiLedgerEntry[]> {
  const { rows } = await query<{
    id: string;
    kind: LedgerKind;
    amount_rial: string;
    actual_cost_rial: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    note: string | null;
    created_at: string;
  }>(
    `SELECT id, kind, amount_rial, actual_cost_rial, input_tokens, output_tokens, note, created_at
       FROM ai_credit_ledger
      WHERE business_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [businessId, Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    amountRial: numberValue(row.amount_rial),
    actualCostRial: row.actual_cost_rial === null ? null : numberValue(row.actual_cost_rial),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    note: row.note,
    createdAt: row.created_at,
  }));
}

export async function createAiTopUpRequest(input: {
  businessId: string;
  packageId: string;
  note?: string;
}): Promise<AiTopUpRequest> {
  const { rows: packages } = await query<{
    id: string;
    name: string;
    price_rial: string;
    credit_amount_rial: string;
  }>(
    `SELECT id, name, price_rial, credit_amount_rial
       FROM ai_credit_packages
      WHERE id = $1 AND is_active`,
    [input.packageId],
  );
  const selected = packages[0];
  if (!selected) throw new Error("not_found");

  const { rows } = await query<{
    id: string;
    business_id: string;
    package_id: string | null;
    package_name: string;
    price_rial: string;
    credit_amount_rial: string;
    note: string | null;
    status: "pending" | "approved" | "rejected";
    reviewed_at: string | null;
    created_at: string;
  }>(
    `INSERT INTO ai_top_up_requests
       (business_id, package_id, package_name, price_rial, credit_amount_rial, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, business_id, package_id, package_name, price_rial, credit_amount_rial,
               note, status, reviewed_at, created_at`,
    [
      input.businessId,
      selected.id,
      selected.name,
      selected.price_rial,
      selected.credit_amount_rial,
      input.note?.trim() || null,
    ],
  );
  const row = rows[0];
  return {
    id: row.id,
    businessId: row.business_id,
    businessName: null,
    packageId: row.package_id,
    packageName: row.package_name,
    priceRial: numberValue(row.price_rial),
    creditAmountRial: numberValue(row.credit_amount_rial),
    note: row.note,
    status: row.status,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

export async function reserveAiTurn(input: {
  businessId: string;
  reservedRial: number;
  userId: string;
}): Promise<AiTurnReservation> {
  if (!positiveInteger(input.reservedRial)) throw new AiInsufficientCreditError();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ balance_rial: string }>(
      `SELECT balance_rial FROM ai_business_billing
        WHERE business_id = $1
        FOR UPDATE`,
      [input.businessId],
    );
    const balance = numberValue(rows[0]?.balance_rial);
    if (balance < input.reservedRial) {
      await client.query("ROLLBACK");
      throw new AiInsufficientCreditError();
    }

    const requestId = randomUUID();
    await client.query(
      `UPDATE ai_business_billing
          SET balance_rial = balance_rial - $2, updated_at = now()
        WHERE business_id = $1`,
      [input.businessId, input.reservedRial],
    );
    await client.query(
      `INSERT INTO ai_credit_ledger
         (business_id, kind, amount_rial, request_id, created_by_user_id, metadata)
       VALUES ($1, 'usage', $2, $3, $4, $5::jsonb)`,
      [
        input.businessId,
        -input.reservedRial,
        requestId,
        input.userId,
        JSON.stringify({ reservedRial: input.reservedRial, phase: "reserved" }),
      ],
    );
    await client.query("COMMIT");
    return { requestId, reservedRial: input.reservedRial };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The earlier rollback can already have closed the transaction.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function settleAiTurn(input: {
  businessId: string;
  reservation: AiTurnReservation;
  usage: AiTokenUsage;
  inputTokenRialPerMillion: number;
  outputTokenRialPerMillion: number;
}): Promise<{ chargedRial: number; refundedRial: number; overageRial: number }> {
  const actualRial = calculateAiUsageCostRial(input.usage, {
    inputTokenRialPerMillion: input.inputTokenRialPerMillion,
    outputTokenRialPerMillion: input.outputTokenRialPerMillion,
  });
  const chargedRial = Math.min(actualRial, input.reservation.reservedRial);
  const refundedRial = input.reservation.reservedRial - chargedRial;
  const overageRial = Math.max(actualRial - input.reservation.reservedRial, 0);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `UPDATE ai_credit_ledger
          SET actual_cost_rial = $3,
              input_tokens = $4,
              output_tokens = $5,
              metadata = metadata || $6::jsonb
        WHERE business_id = $1 AND request_id = $2 AND kind = 'usage'
        RETURNING id`,
      [
        input.businessId,
        input.reservation.requestId,
        chargedRial,
        Math.max(0, Math.floor(input.usage.inputTokens)),
        Math.max(0, Math.floor(input.usage.outputTokens)),
        JSON.stringify({ actualRial, overageRial, phase: "settled" }),
      ],
    );
    if (!rows[0]) throw new Error("ai_reservation_not_found");

    if (refundedRial > 0) {
      await client.query(
        `UPDATE ai_business_billing
            SET balance_rial = balance_rial + $2, updated_at = now()
          WHERE business_id = $1`,
        [input.businessId, refundedRial],
      );
      await client.query(
        `INSERT INTO ai_credit_ledger
           (business_id, kind, amount_rial, request_id, metadata)
         VALUES ($1, 'usage_refund', $2, $3, $4::jsonb)`,
        [
          input.businessId,
          refundedRial,
          input.reservation.requestId,
          JSON.stringify({ actualRial, reservedRial: input.reservation.reservedRial }),
        ],
      );
    }
    await client.query("COMMIT");
    return { chargedRial, refundedRial, overageRial };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelAiTurnReservation(input: {
  businessId: string;
  reservation: AiTurnReservation;
  reason: string;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `UPDATE ai_credit_ledger
          SET kind = 'usage_cancelled',
              metadata = metadata || $3::jsonb
        WHERE business_id = $1 AND request_id = $2 AND kind = 'usage'
        RETURNING id`,
      [
        input.businessId,
        input.reservation.requestId,
        JSON.stringify({ phase: "cancelled", reason: input.reason }),
      ],
    );
    if (rows[0]) {
      await client.query(
        `UPDATE ai_business_billing
            SET balance_rial = balance_rial + $2, updated_at = now()
          WHERE business_id = $1`,
        [input.businessId, input.reservation.reservedRial],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function grantCreditInTransaction(
  client: PoolClient,
  input: {
    businessId: string;
    amountRial: number;
    kind: "manual_grant" | "top_up" | "subscription";
    note?: string | null;
    platformAdminId?: string | null;
  },
): Promise<string> {
  if (!positiveInteger(input.amountRial)) throw new Error("invalid_credit_amount");
  await client.query(
    `INSERT INTO ai_business_billing (business_id, balance_rial)
     VALUES ($1, $2)
     ON CONFLICT (business_id)
     DO UPDATE SET balance_rial = ai_business_billing.balance_rial + EXCLUDED.balance_rial,
                   updated_at = now()`,
    [input.businessId, input.amountRial],
  );
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ai_credit_ledger
       (business_id, kind, amount_rial, note, platform_admin_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.businessId, input.kind, input.amountRial, input.note?.trim() || null, input.platformAdminId ?? null],
  );
  return rows[0].id;
}

export async function grantAiCredits(input: {
  businessId: string;
  amountRial: number;
  note?: string;
  platformAdminId: string;
}): Promise<void> {
  await withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await grantCreditInTransaction(client, {
        businessId: input.businessId,
        amountRial: input.amountRial,
        kind: "manual_grant",
        note: input.note,
        platformAdminId: input.platformAdminId,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function assignAiSubscription(input: {
  businessId: string;
  subscriptionPlanId: string | null;
  platformAdminId: string;
}): Promise<void> {
  await withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      if (!input.subscriptionPlanId) {
        await client.query(
          `INSERT INTO ai_business_billing (business_id)
           VALUES ($1)
           ON CONFLICT (business_id)
           DO UPDATE SET subscription_plan_id = NULL, subscription_renews_at = NULL, updated_at = now()`,
          [input.businessId],
        );
        await client.query("COMMIT");
        return;
      }

      const { rows: planRows } = await client.query<{
        id: string;
        name: string;
        monthly_credit_rial: string;
      }>(
        `SELECT id, name, monthly_credit_rial
           FROM ai_subscription_plans
          WHERE id = $1 AND is_active`,
        [input.subscriptionPlanId],
      );
      const plan = planRows[0];
      if (!plan) throw new Error("not_found");

      await client.query(
        `INSERT INTO ai_business_billing (business_id, subscription_plan_id, subscription_renews_at)
         VALUES ($1, $2, now() + interval '1 month')
         ON CONFLICT (business_id)
         DO UPDATE SET subscription_plan_id = EXCLUDED.subscription_plan_id,
                       subscription_renews_at = EXCLUDED.subscription_renews_at,
                       updated_at = now()`,
        [input.businessId, plan.id],
      );
      await grantCreditInTransaction(client, {
        businessId: input.businessId,
        amountRial: numberValue(plan.monthly_credit_rial),
        kind: "subscription",
        note: `اعتبار اولیهٔ اشتراک «${plan.name}»`,
        platformAdminId: input.platformAdminId,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function listPlatformAiBusinesses(): Promise<AiPlatformBusiness[]> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      business_id: string;
      business_name: string;
      business_status: string;
      balance_rial: string | null;
      subscription_plan_id: string | null;
      subscription_plan_name: string | null;
      subscription_renews_at: string | null;
      usage_rial_last_30_days: string | null;
      pending_top_ups: string;
    }>(
      `SELECT b.id AS business_id,
              b.name AS business_name,
              b.status::text AS business_status,
              bb.balance_rial,
              sp.id AS subscription_plan_id,
              sp.name AS subscription_plan_name,
              bb.subscription_renews_at,
              (SELECT coalesce(sum(l.actual_cost_rial), 0)
                 FROM ai_credit_ledger l
                WHERE l.business_id = b.id
                  AND l.kind = 'usage'
                  AND l.created_at >= now() - interval '30 days') AS usage_rial_last_30_days,
              (SELECT count(*)
                 FROM ai_top_up_requests r
                WHERE r.business_id = b.id AND r.status = 'pending') AS pending_top_ups
         FROM businesses b
         LEFT JOIN ai_business_billing bb ON bb.business_id = b.id
         LEFT JOIN ai_subscription_plans sp ON sp.id = bb.subscription_plan_id
        ORDER BY b.created_at DESC`,
    );
    return rows.map((row) => ({
      businessId: row.business_id,
      businessName: row.business_name,
      businessStatus: row.business_status,
      balanceRial: numberValue(row.balance_rial),
      subscriptionPlanId: row.subscription_plan_id,
      subscriptionPlanName: row.subscription_plan_name,
      subscriptionRenewsAt: row.subscription_renews_at,
      usageRialLast30Days: numberValue(row.usage_rial_last_30_days),
      pendingTopUps: numberValue(row.pending_top_ups),
    }));
  });
}

export async function listPlatformAiTopUpRequests(
  pendingOnly = false,
): Promise<AiTopUpRequest[]> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      id: string;
      business_id: string;
      business_name: string;
      package_id: string | null;
      package_name: string;
      price_rial: string;
      credit_amount_rial: string;
      note: string | null;
      status: "pending" | "approved" | "rejected";
      reviewed_at: string | null;
      created_at: string;
    }>(
      `SELECT r.id, r.business_id, b.name AS business_name, r.package_id, r.package_name,
              r.price_rial, r.credit_amount_rial, r.note, r.status, r.reviewed_at, r.created_at
         FROM ai_top_up_requests r
         JOIN businesses b ON b.id = r.business_id
        WHERE ($1::boolean = false OR r.status = 'pending')
        ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC
        LIMIT 200`,
      [pendingOnly],
    );
    return rows.map((row) => ({
      id: row.id,
      businessId: row.business_id,
      businessName: row.business_name,
      packageId: row.package_id,
      packageName: row.package_name,
      priceRial: numberValue(row.price_rial),
      creditAmountRial: numberValue(row.credit_amount_rial),
      note: row.note,
      status: row.status,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at,
    }));
  });
}

export async function reviewAiTopUpRequest(input: {
  requestId: string;
  status: "approved" | "rejected";
  platformAdminId: string;
}): Promise<AiTopUpRequest> {
  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows: requestRows } = await client.query<{
        id: string;
        business_id: string;
        package_id: string | null;
        package_name: string;
        price_rial: string;
        credit_amount_rial: string;
        note: string | null;
        status: "pending" | "approved" | "rejected";
        reviewed_at: string | null;
        created_at: string;
      }>(
        `SELECT id, business_id, package_id, package_name, price_rial, credit_amount_rial,
                note, status, reviewed_at, created_at
           FROM ai_top_up_requests
          WHERE id = $1
          FOR UPDATE`,
        [input.requestId],
      );
      const request = requestRows[0];
      if (!request) throw new Error("not_found");
      if (request.status !== "pending") throw new AiTopUpStateError();

      let ledgerId: string | null = null;
      if (input.status === "approved") {
        ledgerId = await grantCreditInTransaction(client, {
          businessId: request.business_id,
          amountRial: numberValue(request.credit_amount_rial),
          kind: "top_up",
          note: `تأیید شارژ «${request.package_name}»`,
          platformAdminId: input.platformAdminId,
        });
      }

      const { rows: updatedRows } = await client.query<{
        id: string;
        business_id: string;
        package_id: string | null;
        package_name: string;
        price_rial: string;
        credit_amount_rial: string;
        note: string | null;
        status: "pending" | "approved" | "rejected";
        reviewed_at: string | null;
        created_at: string;
      }>(
        `UPDATE ai_top_up_requests
            SET status = $2, reviewed_by = $3, reviewed_at = now(), fulfilled_ledger_id = $4
          WHERE id = $1
          RETURNING id, business_id, package_id, package_name, price_rial, credit_amount_rial,
                    note, status, reviewed_at, created_at`,
        [input.requestId, input.status, input.platformAdminId, ledgerId],
      );
      await client.query("COMMIT");
      const row = updatedRows[0];
      return {
        id: row.id,
        businessId: row.business_id,
        businessName: null,
        packageId: row.package_id,
        packageName: row.package_name,
        priceRial: numberValue(row.price_rial),
        creditAmountRial: numberValue(row.credit_amount_rial),
        note: row.note,
        status: row.status,
        reviewedAt: row.reviewed_at,
        createdAt: row.created_at,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

/**
 * Runs on the custom server's hourly tick. Missed months do not create a burst
 * of retroactive free credit: one renewal is granted, then the next date is
 * moved one month ahead from now. Each business is re-entered through
 * withTenant so the ordinary tenant RLS policy still protects the write.
 */
export async function runAiSubscriptionRenewalTick(): Promise<number> {
  const due = await withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      business_id: string;
      subscription_plan_id: string;
      monthly_credit_rial: string;
      plan_name: string;
    }>(
      `SELECT bb.business_id, bb.subscription_plan_id, sp.monthly_credit_rial, sp.name AS plan_name
         FROM ai_business_billing bb
         JOIN ai_subscription_plans sp ON sp.id = bb.subscription_plan_id
        WHERE sp.is_active AND bb.subscription_renews_at <= now()`,
    );
    return rows;
  });

  let renewed = 0;
  for (const item of due) {
    const didRenew = await withTenant(item.business_id, async () => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ business_id: string }>(
          `UPDATE ai_business_billing
              SET balance_rial = balance_rial + $3,
                  subscription_renews_at = now() + interval '1 month',
                  updated_at = now()
            WHERE business_id = $1
              AND subscription_plan_id = $2
              AND subscription_renews_at <= now()
            RETURNING business_id`,
          [item.business_id, item.subscription_plan_id, numberValue(item.monthly_credit_rial)],
        );
        if (!rows[0]) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query(
          `INSERT INTO ai_credit_ledger (business_id, kind, amount_rial, note)
           VALUES ($1, 'subscription', $2, $3)`,
          [
            item.business_id,
            numberValue(item.monthly_credit_rial),
            `تمدید ماهانهٔ اشتراک «${item.plan_name}»`,
          ],
        );
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
    if (didRenew) renewed += 1;
  }
  return renewed;
}
