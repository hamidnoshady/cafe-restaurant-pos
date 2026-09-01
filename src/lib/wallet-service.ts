/**
 * Platform business-wallet operations: balances, the credit ledger, online
 * payments (Zarinpal) and manual top-up approval.
 *
 * This is the single payment system every important platform function spends
 * from. A per-use feature charge is `chargeFeatureUse`; add-on/plan purchases
 * go through the payment flow and land as ledger credits/entitlements.
 *
 * Every balance mutation is a row-locked transaction (`SELECT … FOR UPDATE`
 * on the wallet row) so two concurrent requests can never spend or grant the
 * same Rial twice. Money is integer Rial everywhere.
 */
import { getPool, query, withTenant, type PoolClient } from "./db";
import {
  zarinpalRequest,
  zarinpalVerify,
  zarinpalPaymentUrl,
  GatewayError,
  type PaymentGatewayConfig,
} from "./payment-gateway";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LedgerKind =
  | "top_up"
  | "payment"
  | "admin_grant"
  | "refund"
  | "feature_charge"
  | "addon_purchase"
  | "plan_fee"
  | "subscription"
  | "admin_adjust"
  | "free_promo";

export interface WalletSummary {
  businessId: string;
  balanceRial: number;
  totalToppedUpRial: number;
  totalSpentRial: number;
}

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  direction: "credit" | "debit";
  amountRial: number;
  balanceAfterRial: number;
  featureKey: string | null;
  note: string | null;
  createdAt: string;
}

export interface CreditPackage {
  id: string;
  name: string;
  priceRial: number;
  creditRial: number;
  isActive: boolean;
  sortOrder: number;
}

export type PaymentStatus = "pending" | "redirect" | "verified" | "failed" | "cancelled";

export interface PaymentRecord {
  id: string;
  businessId: string;
  gateway: "manual" | "zarinpal";
  purpose: "top_up" | "plan_purchase" | "addon_purchase";
  packageId: string | null;
  planKey: string | null;
  featureKey: string | null;
  amountRial: number;
  creditRial: number;
  description: string;
  status: PaymentStatus;
  authority: string | null;
  gatewayRef: string | null;
  createdAt: string;
  verifiedAt: string | null;
  businessName?: string | null;
}

export class WalletInsufficientFundsError extends Error {
  constructor(
    public requiredRial: number,
    public balanceRial: number,
  ) {
    super("insufficient_credits");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function n(v: string | number | null | undefined): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function positiveInt(v: number): boolean {
  return Number.isSafeInteger(v) && v > 0;
}

/** Runs `fn` inside a transaction with the row lock on the wallet held. */
async function withWalletTx<T>(
  client: PoolClient,
  businessId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    await client.query("BEGIN");
    // Ensures the wallet row exists and locks it for the transaction.
    await client.query(
      `INSERT INTO business_wallets (business_id) VALUES ($1)
       ON CONFLICT (business_id) DO NOTHING`,
      [businessId],
    );
    await client.query(
      `SELECT business_id FROM business_wallets WHERE business_id = $1 FOR UPDATE`,
      [businessId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

async function writeLedger(
  client: PoolClient,
  entry: {
    businessId: string;
    kind: LedgerKind;
    direction: "credit" | "debit";
    amountRial: number;
    featureKey?: string | null;
    paymentId?: string | null;
    note?: string | null;
    metadata?: Record<string, unknown>;
    userId?: string | null;
    platformAdminId?: string | null;
  },
): Promise<{ id: string; balanceAfterRial: number }> {
  const delta = entry.direction === "credit" ? entry.amountRial : -entry.amountRial;
  // Callers that debit (chargeFeatureUse / deductCredits) check cover before
  // writing; the GREATEST keeps a bug from ever producing a negative balance.
  const isTopUp = entry.kind === "top_up" || entry.kind === "payment";
  await client.query(
    `UPDATE business_wallets
        SET balance_rial = GREATEST(0, balance_rial + $2),
            total_topped_up_rial = CASE WHEN $3 THEN total_topped_up_rial + $4 ELSE total_topped_up_rial END,
            total_spent_rial     = CASE WHEN $5 THEN total_spent_rial + $4 ELSE total_spent_rial END,
            updated_at = now()
      WHERE business_id = $1`,
    [entry.businessId, delta, isTopUp, entry.amountRial, entry.direction === "debit"],
  );
  const { rows: ledgerRows } = await client.query<{ id: string; balance_after_rial: string }>(
    `INSERT INTO wallet_ledger
       (business_id, kind, direction, amount_rial, balance_after_rial,
        feature_key, payment_id, note, metadata, created_by_user_id, platform_admin_id)
     SELECT $1, $2, $3, $4, balance_rial, $5, $6, $7, $8::jsonb, $9, $10
       FROM business_wallets WHERE business_id = $1
     RETURNING id, balance_after_rial`,
    [
      entry.businessId,
      entry.kind,
      entry.direction,
      entry.amountRial,
      entry.featureKey ?? null,
      entry.paymentId ?? null,
      entry.note ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.userId ?? null,
      entry.platformAdminId ?? null,
    ],
  );
  return { id: ledgerRows[0].id, balanceAfterRial: n(ledgerRows[0].balance_after_rial) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getWallet(businessId: string): Promise<WalletSummary> {
  await query(
    `INSERT INTO business_wallets (business_id) VALUES ($1) ON CONFLICT (business_id) DO NOTHING`,
    [businessId],
  );
  const { rows } = await query<{
    balance_rial: string;
    total_topped_up_rial: string;
    total_spent_rial: string;
  }>(
    `SELECT balance_rial, total_topped_up_rial, total_spent_rial
       FROM business_wallets WHERE business_id = $1`,
    [businessId],
  );
  const row = rows[0];
  return {
    businessId,
    balanceRial: n(row?.balance_rial),
    totalToppedUpRial: n(row?.total_topped_up_rial),
    totalSpentRial: n(row?.total_spent_rial),
  };
}

/** Fast balance-only read for the header badge. */
export async function getWalletBalanceRial(businessId: string): Promise<number> {
  const wallet = await getWallet(businessId);
  return wallet.balanceRial;
}

export async function listLedger(businessId: string, limit = 50): Promise<LedgerEntry[]> {
  const { rows } = await query<{
    id: string;
    kind: LedgerKind;
    direction: "credit" | "debit";
    amount_rial: string;
    balance_after_rial: string;
    feature_key: string | null;
    note: string | null;
    created_at: string;
  }>(
    `SELECT id, kind, direction, amount_rial, balance_after_rial, feature_key, note, created_at
       FROM wallet_ledger WHERE business_id = $1
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [businessId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    direction: r.direction,
    amountRial: n(r.amount_rial),
    balanceAfterRial: n(r.balance_after_rial),
    featureKey: r.feature_key,
    note: r.note,
    createdAt: r.created_at,
  }));
}

export async function listCreditPackages(activeOnly = false): Promise<CreditPackage[]> {
  const { rows } = await query<{
    id: string;
    name: string;
    price_rial: string;
    credit_rial: string;
    is_active: boolean;
    sort_order: number;
  }>(
    `SELECT id, name, price_rial, credit_rial, is_active, sort_order
       FROM credit_packages
      WHERE ($1::boolean = false OR is_active)
      ORDER BY sort_order, created_at, id`,
    [activeOnly],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    priceRial: n(r.price_rial),
    creditRial: n(r.credit_rial),
    isActive: r.is_active,
    sortOrder: r.sort_order,
  }));
}

// ---------------------------------------------------------------------------
// Credit packages catalogue (super-admin)
// ---------------------------------------------------------------------------

export async function saveCreditPackage(input: {
  id?: string;
  name: string;
  priceRial: number;
  creditRial: number;
  isActive: boolean;
  sortOrder: number;
}): Promise<CreditPackage> {
  const name = input.name.trim();
  if (!name) throw new Error("missing_fields");
  if (!positiveInt(input.priceRial) || !positiveInt(input.creditRial)) throw new Error("bad_amount");

  const { rows } = await query<{ id: string }>(
    `INSERT INTO credit_packages (id, name, price_rial, credit_rial, is_active, sort_order)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, price_rial = EXCLUDED.price_rial,
       credit_rial = EXCLUDED.credit_rial, is_active = EXCLUDED.is_active,
       sort_order = EXCLUDED.sort_order, updated_at = now()
     RETURNING id`,
    [input.id ?? null, name, input.priceRial, input.creditRial, input.isActive, input.sortOrder || 0],
  );
  const saved = await listCreditPackages();
  const pkg = saved.find((p) => p.id === rows[0].id);
  if (!pkg) throw new Error("save_failed");
  return pkg;
}

export async function deleteCreditPackage(id: string): Promise<void> {
  await query(`DELETE FROM credit_packages WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// Admin grants / adjustments
// ---------------------------------------------------------------------------

/** Super-admin: grant credits directly (manual grant / comp / refund). */
export async function grantCredits(input: {
  businessId: string;
  amountRial: number;
  note?: string;
  platformAdminId?: string | null;
}): Promise<{ balanceRial: number }> {
  if (!positiveInt(input.amountRial)) throw new Error("bad_amount");
  const client = await getPool().connect();
  try {
    return await withWalletTx(client, input.businessId, async (c) => {
      const { balanceAfterRial } = await writeLedger(c, {
        businessId: input.businessId,
        kind: "admin_grant",
        direction: "credit",
        amountRial: input.amountRial,
        note: input.note ?? "شارژ دستی توسط مدیر سامانه",
        platformAdminId: input.platformAdminId ?? null,
      });
      return { balanceRial: balanceAfterRial };
    });
  } finally {
    client.release();
  }
}

/** Super-admin: deduct credits (correction). Refuses if the balance cannot cover it. */
export async function deductCredits(input: {
  businessId: string;
  amountRial: number;
  note?: string;
  platformAdminId?: string | null;
}): Promise<{ balanceRial: number }> {
  if (!positiveInt(input.amountRial)) throw new Error("bad_amount");
  const client = await getPool().connect();
  try {
    return await withWalletTx(client, input.businessId, async (c) => {
      const { rows } = await c.query<{ balance_rial: string }>(
        `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
        [input.businessId],
      );
      if (n(rows[0]?.balance_rial) < input.amountRial) {
        throw new WalletInsufficientFundsError(input.amountRial, n(rows[0]?.balance_rial));
      }
      const { balanceAfterRial } = await writeLedger(c, {
        businessId: input.businessId,
        kind: "admin_adjust",
        direction: "debit",
        amountRial: input.amountRial,
        note: input.note ?? "کسر دستی توسط مدیر سامانه",
        platformAdminId: input.platformAdminId ?? null,
      });
      return { balanceRial: balanceAfterRial };
    });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Per-use feature charge — what every important function calls
// ---------------------------------------------------------------------------

/**
 * Charge a business's wallet for one metered use of `featureKey`.
 *
 * Returns the new balance. Throws `WalletInsufficientFundsError` when the
 * wallet cannot cover the charge — callers turn that into the "buy credits"
 * prompt. The charge is one row-locked transaction with its ledger entry, so
 * concurrent uses can never double-spend.
 *
 * `free` (zero-cost) calls are recorded in `feature_usage` counters but never
 * touch the ledger, matching the plan builder's "free / no cost" pricing.
 */
export async function chargeFeatureUse(input: {
  businessId: string;
  featureKey: string;
  priceRial: number;
  note?: string;
  userId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<{ charged: boolean; balanceRial: number }> {
  const price = Math.max(0, Math.floor(n(input.priceRial)));
  const client = await getPool().connect();
  try {
    if (price <= 0) {
      // Free / unpriced use: no money moves and (for an unpriced function that
      // the metering layer does not know) no usage row either; a zero-price
      // *metered* feature still counts usage so the free-for-N-uses promo can
      // tick. Callers signal a metered feature via metadata.metered.
      const metered = input.metadata?.metered === true;
      if (metered) {
        await client.query(
          `INSERT INTO feature_usage (business_id, feature_key, used_count, charged_count, spent_rial)
           VALUES ($1, $2, 1, 0, 0)
           ON CONFLICT (business_id, feature_key) DO UPDATE SET
             used_count = feature_usage.used_count + 1, updated_at = now()`,
          [input.businessId, input.featureKey],
        );
      }
      const { rows } = await client.query<{ balance_rial: string }>(
        `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
        [input.businessId],
      );
      return { charged: false, balanceRial: n(rows[0]?.balance_rial) };
    }

    // The paid use is counted inside the wallet transaction (below), only
    // after the balance check succeeds — a refused charge must not tick the
    // charged/spent counters.

    return await withWalletTx(client, input.businessId, async (c) => {
      const { rows } = await c.query<{ balance_rial: string }>(
        `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
        [input.businessId],
      );
      const balance = n(rows[0]?.balance_rial);
      if (balance < price) {
        throw new WalletInsufficientFundsError(price, balance);
      }
      // Count the use on the same locked transaction so usage never moves
      // without the matching debit.
      await c.query(
        `INSERT INTO feature_usage (business_id, feature_key, used_count, charged_count, spent_rial)
         VALUES ($1, $2, 1, 1, $3)
         ON CONFLICT (business_id, feature_key) DO UPDATE SET
           used_count = feature_usage.used_count + 1,
           charged_count = feature_usage.charged_count + 1,
           spent_rial = feature_usage.spent_rial + $3,
           updated_at = now()`,
        [input.businessId, input.featureKey, price],
      );
      const { balanceAfterRial } = await writeLedger(c, {
        businessId: input.businessId,
        kind: "feature_charge",
        direction: "debit",
        amountRial: price,
        featureKey: input.featureKey,
        note: input.note ?? `هزینهٔ استفاده از قابلیت «${input.featureKey}»`,
        userId: input.userId ?? null,
        metadata: input.metadata,
      });
      return { charged: true, balanceRial: balanceAfterRial };
    });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Payments: create / start / verify / review
// ---------------------------------------------------------------------------

export async function getPaymentConfig(): Promise<PaymentGatewayConfig> {
  await query(
    `INSERT INTO platform_payment_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING`,
  );
  const { rows } = await query<{
    gateway: "manual" | "zarinpal";
    merchant_id: string;
    sandbox: boolean;
    callback_url: string;
    currency: "IRR" | "IRT";
  }>(
    `SELECT gateway, merchant_id, sandbox, callback_url, currency
       FROM platform_payment_config WHERE id = true`,
  );
  const row = rows[0];
  return {
    gateway: row?.gateway ?? "manual",
    merchantId: row?.merchant_id ?? "",
    sandbox: row?.sandbox ?? true,
    callbackUrl: row?.callback_url ?? "",
    currency: row?.currency ?? "IRR",
  };
}

export async function savePaymentConfig(
  input: Partial<PaymentGatewayConfig> & { platformAdminId?: string | null },
): Promise<PaymentGatewayConfig> {
  const current = await getPaymentConfig();
  const next: PaymentGatewayConfig = {
    gateway: input.gateway ?? current.gateway,
    merchantId: input.merchantId ?? current.merchantId,
    sandbox: input.sandbox ?? current.sandbox,
    callbackUrl: input.callbackUrl ?? current.callbackUrl,
    currency: input.currency ?? current.currency,
  };
  if (!["manual", "zarinpal"].includes(next.gateway)) throw new Error("bad_gateway");
  await query(
    `UPDATE platform_payment_config
        SET gateway = $1, merchant_id = $2, sandbox = $3, callback_url = $4,
            currency = $5, updated_by = $6, updated_at = now()
      WHERE id = true`,
    [next.gateway, next.merchantId.trim(), next.sandbox, next.callbackUrl.trim(), next.currency, input.platformAdminId ?? null],
  );
  return next;
}

/**
 * Create a payment row (status pending). For top-ups pass packageId/amount;
 * for plan/addon purchases pass planKey/featureKey. Returns the new id so the
 * caller can then call the gateway and redirect.
 */
export async function createPayment(input: {
  businessId: string;
  purpose: "top_up" | "plan_purchase" | "addon_purchase";
  amountRial: number;
  creditRial?: number;
  packageId?: string | null;
  planKey?: string | null;
  featureKey?: string | null;
  description: string;
  userId?: string | null;
}): Promise<PaymentRecord> {
  if (!positiveInt(input.amountRial)) throw new Error("bad_amount");
  const gateway = (await getPaymentConfig()).gateway;
  const { rows } = await query<Record<string, unknown>>(
    `INSERT INTO billing_payments
       (business_id, gateway, purpose, package_id, plan_key, feature_key,
        amount_rial, credit_rial, description, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      input.businessId,
      gateway,
      input.purpose,
      input.packageId ?? null,
      input.planKey ?? null,
      input.featureKey ?? null,
      input.amountRial,
      Math.max(0, n(input.creditRial)),
      input.description,
      input.userId ?? null,
    ],
  );
  return rowToPayment(rows[0]);
}

/**
 * Start a pending payment: ask Zarinpal for an authority and persist it.
 * Returns the URL to redirect the browser to. For the `manual` gateway there
 * is no redirect — the payment simply waits for admin approval.
 */
export async function startPayment(
  paymentId: string,
  opts: { email?: string | null; mobile?: string | null } = {},
): Promise<{ redirectUrl: string | null; gateway: string }> {
  const config = await getPaymentConfig();
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM billing_payments WHERE id = $1 FOR UPDATE`,
    [paymentId],
  );
  const payment = rows[0] ? rowToPayment(rows[0]) : null;
  if (!payment) throw new GatewayError("payment_not_found");
  if (payment.status !== "pending") throw new GatewayError("payment_not_pending");

  if (config.gateway === "manual") {
    return { redirectUrl: null, gateway: "manual" };
  }

  const { authority, redirectUrl } = await zarinpalRequest(config, {
    amountRial: payment.amountRial,
    description: payment.description,
    paymentId: payment.id,
    email: opts.email ?? null,
    mobile: opts.mobile ?? null,
  });
  await query(
    `UPDATE billing_payments SET status = 'redirect', authority = $2, gateway = 'zarinpal'
      WHERE id = $1`,
    [paymentId, authority],
  );
  return { redirectUrl, gateway: "zarinpal" };
}

/**
 * Verify a payment the gateway redirected back. Idempotent: a second verify
 * of an already-verified payment returns its record without double-crediting
 * (the unique payment_id ledger index is the hard guarantee).
 */
export async function verifyPayment(input: {
  paymentId: string;
  authority: string;
  status: string; // Zarinpal returns 'OK' / 'NOK' in query params
}): Promise<PaymentRecord> {
  const config = await getPaymentConfig();
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM billing_payments WHERE id = $1`,
    [input.paymentId],
  );
  const payment = rows[0] ? rowToPayment(rows[0]) : null;
  if (!payment) throw new GatewayError("payment_not_found");
  if (payment.status === "verified") return payment;
  if (payment.status !== "redirect" && payment.status !== "pending") {
    throw new GatewayError("payment_not_pending");
  }

  const ok = input.status?.toUpperCase() === "OK" && Boolean(input.authority);
  if (!ok) {
    await query(
      `UPDATE billing_payments SET status = 'cancelled', gateway_status = $2 WHERE id = $1`,
      [payment.id, input.status ?? "NOK"],
    );
    return (await getPaymentById(payment.id))!;
  }

  const result = await zarinpalVerify(config, {
    amountRial: payment.amountRial,
    authority: input.authority,
  });
  if (!result.verified) {
    await query(
      `UPDATE billing_payments SET status = 'failed', gateway_status = COALESCE($2, 'unverified')
       WHERE id = $1`,
      [payment.id, result.code ? String(result.code) : "NOK"],
    );
    return (await getPaymentById(payment.id))!;
  }

  await settlePayment(payment.id, {
    gatewayRef: result.refId ?? null,
    gatewayStatus: result.code ? String(result.code) : "100",
  });
  return (await getPaymentById(payment.id))!;
}

/**
 * Mark a payment settled and post its wallet credit inside one transaction.
 * Shared by Zarinpal verify and manual admin approval.
 */
export async function settlePayment(
  paymentId: string,
  opts: { gatewayRef?: string | null; gatewayStatus?: string; platformAdminId?: string | null } = {},
): Promise<PaymentRecord> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT * FROM billing_payments WHERE id = $1 FOR UPDATE`,
      [paymentId],
    );
    const payment = rows[0] ? rowToPayment(rows[0]) : null;
    if (!payment) {
      await client.query("ROLLBACK");
      throw new GatewayError("payment_not_found");
    }
    if (payment.status === "verified") {
      await client.query("COMMIT");
      return payment;
    }
    if (payment.status !== "redirect" && payment.status !== "pending") {
      await client.query("ROLLBACK");
      throw new GatewayError("payment_not_pending");
    }

    // Wallet credit — the unique payment_id index on wallet_ledger makes the
    // credit exactly-once even if settle is raced.
    await client.query(
      `INSERT INTO business_wallets (business_id) VALUES ($1) ON CONFLICT (business_id) DO NOTHING`,
      [payment.businessId],
    );
    if (payment.creditRial > 0) {
      await client.query(
        `UPDATE business_wallets
            SET balance_rial = balance_rial + $2,
                total_topped_up_rial = total_topped_up_rial + $2,
                updated_at = now()
          WHERE business_id = $1`,
        [payment.businessId, payment.creditRial],
      );
      await client.query(
        `INSERT INTO wallet_ledger
           (business_id, kind, direction, amount_rial, balance_after_rial,
            payment_id, note, metadata, platform_admin_id)
         SELECT $1, 'top_up', 'credit', $2, balance_rial, $3, $4, '{}'::jsonb, $5
           FROM business_wallets WHERE business_id = $1`,
        [
          payment.businessId,
          payment.creditRial,
          payment.id,
          `شارژ اعتبار از طریق ${payment.gateway === "zarinpal" ? "درگاه زرین‌پال" : "پرداخت دستی"}`,
          opts.platformAdminId ?? null,
        ],
      );
    }

    // Plan/addon purchases record their entitlement (the plan-builder service
    // owns entitlement rows; payment only flags the purchase as settled).
    await client.query(
      `UPDATE billing_payments
          SET status = 'verified', gateway_ref = $2, gateway_status = COALESCE($3, 'verified'),
              verified_at = now(), reviewed_at = COALESCE(reviewed_at, now()),
              reviewed_by = COALESCE(reviewed_by, $4)
        WHERE id = $1`,
      [payment.id, opts.gatewayRef ?? null, opts.gatewayStatus ?? null, opts.platformAdminId ?? null],
    );
    await client.query("COMMIT");
    return (await getPaymentById(payment.id))!;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Super-admin: reject a pending manual payment. */
export async function rejectPayment(
  paymentId: string,
  opts: { platformAdminId?: string | null; note?: string } = {},
): Promise<void> {
  await query(
    `UPDATE billing_payments SET status = 'failed', reviewed_by = $2, reviewed_at = now(),
            gateway_status = COALESCE(gateway_status, 'rejected')
      WHERE id = $1 AND status IN ('pending','redirect')`,
    [paymentId, opts.platformAdminId ?? null],
  );
}

export async function getPaymentById(id: string): Promise<PaymentRecord | null> {
  const { rows } = await query<Record<string, unknown>>(`SELECT * FROM billing_payments WHERE id = $1`, [id]);
  return rows[0] ? rowToPayment(rows[0]) : null;
}

export async function listPayments(
  options: { businessId?: string; status?: PaymentStatus; limit?: number } = {},
): Promise<PaymentRecord[]> {
  const limit = Math.min(options.limit ?? 100, 500);
  if (options.businessId) {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT * FROM billing_payments WHERE business_id = $1
        AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC, id DESC LIMIT $3`,
      [options.businessId, options.status ?? null, limit],
    );
    return rows.map(rowToPayment);
  }
  // Platform-wide: join business names. RLS is bypassed in platform scope.
  const { rows } = await query<Record<string, unknown>>(
    `SELECT p.*, b.name AS business_name
       FROM billing_payments p JOIN businesses b ON b.id = p.business_id
      WHERE ($2::text IS NULL OR p.status = $2)
      ORDER BY p.created_at DESC, p.id DESC LIMIT $1`,
    [limit, options.status ?? null],
  );
  return rows.map(rowToPayment);
}

function rowToPayment(row: Record<string, unknown>): PaymentRecord {
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    gateway: (row.gateway as "manual" | "zarinpal") ?? "zarinpal",
    purpose: (row.purpose as PaymentRecord["purpose"]) ?? "top_up",
    packageId: (row.package_id as string | null) ?? null,
    planKey: (row.plan_key as string | null) ?? null,
    featureKey: (row.feature_key as string | null) ?? null,
    amountRial: n(row.amount_rial as string | number),
    creditRial: n(row.credit_rial as string | number),
    description: String(row.description ?? ""),
    status: (row.status as PaymentStatus) ?? "pending",
    authority: (row.authority as string | null) ?? null,
    gatewayRef: (row.gateway_ref as string | null) ?? null,
    createdAt: String(row.created_at),
    verifiedAt: (row.verified_at as string | null) ?? null,
    businessName: (row.business_name as string | null) ?? null,
  };
}

/** Re-exported for routes that build a sandbox URL in tests/diagnostics. */
export { zarinpalPaymentUrl };
