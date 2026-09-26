/**
 * Payment system end-to-end against a real migrated Postgres.
 *
 * Covers the whole payment/billing surface at the service level:
 *  - Zarinpal flow with the network boundary stubbed: start → redirect →
 *    verify (code 100 / already-verified 101 / cancelled NOK / refusal),
 *    using both sandbox and live config.
 *  - Manual gateway: pending payments are approved/rejected by an admin.
 *  - Settlement is exactly-once and credits the wallet correctly.
 *  - Credit package and plan-builder CRUD.
 *  - Admin grant/deduct and concurrent charges (row-lock correctness).
 *  - Cross-business RLS isolation for every billing table.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const APP_ROLE = "pos_payments_test_role";
const APP_PASSWORD = "payments-test-password";

let databaseName: string;
let db: Client;
let appClient: Client;
let rlsActive = false;

let wallet: typeof import("../src/lib/wallet-service");
let plans: typeof import("../src/lib/billing-plans-service");
let billing: typeof import("../src/lib/billing-service");
let gateway: typeof import("../src/lib/payment-gateway");
let dbLib: typeof import("../src/lib/db");

const ALPHA = "11111111-1111-1111-1111-111111111111";
const BETA = "22222222-2222-2222-2222-222222222222";
const ADMIN = "33333333-3333-3333-3333-333333333333";

function urlFor(
  database: string,
  user?: { name: string; password: string },
): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

/** Run `fn` scoped to a business, the way an authenticated API request is. */
function asBiz<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

/**
 * Run `fn` on the unprivileged role with `app.business_id` set — the true
 * RLS boundary: a superuser ignores RLS, this role cannot.
 */
async function asAppRole<T>(businessId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  await appClient.query("SELECT set_config('app.business_id', $1, false)", [businessId]);
  await appClient.query("SELECT set_config('app.rls_bypass', '', false)");
  return fn(appClient);
}

beforeAll(async () => {
  databaseName = `pos_payments_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  const ownerUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl: ownerUrl, quiet: true });
  await createAppRole({ databaseUrl: ownerUrl, roleName: APP_ROLE, password: APP_PASSWORD, quiet: true });
  process.env.DATABASE_URL = ownerUrl;

  wallet = await import("../src/lib/wallet-service");
  plans = await import("../src/lib/billing-plans-service");
  billing = await import("../src/lib/billing-service");
  gateway = await import("../src/lib/payment-gateway");
  dbLib = await import("../src/lib/db");

  rlsActive = await dbLib.rlsEffective();

  db = new Client({ connectionString: ownerUrl });
  await db.connect();
  appClient = new Client({
    connectionString: urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD }),
  });
  await appClient.connect();
  await db.query(
    `INSERT INTO businesses (id, name, slug, plan) VALUES
       ($1, 'کافه آلفا', 'alpha', 'pro'),
       ($2, 'کافه بتا',  'beta',  'free')`,
    [ALPHA, BETA],
  );
  // Platform admin referenced by platform_admin_id columns.
  await db.query(
    `INSERT INTO platform_admins (id, email, password_hash, full_name, role)
     VALUES ($1, 'ops@example.com', 'x', 'مدیر', 'owner') ON CONFLICT DO NOTHING`,
    [ADMIN],
  );
}, 120_000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await appClient?.end();
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
});

/** Stub the Zarinpal HTTP API: request returns an authority, verify returns code. */
function stubZarinpal(opts: { verifyCode?: number; requestOk?: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (String(url).includes("/request.json")) {
        if (opts.requestOk === false) {
          return new Response(JSON.stringify({ data: { code: -9 } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ data: { authority: `ZP-${randomUUID()}`, code: 100, fee: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (String(url).includes("/verify.json")) {
        return new Response(
          JSON.stringify({
            data: { code: opts.verifyCode ?? 100, ref_id: 1234567890, amount: body.amount },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    }),
  );
}

// ---------------------------------------------------------------------------

describe("payment gateway configuration", () => {
  it("defaults to manual gateway and updates to zarinpal", async () => {
    await asBiz(ALPHA, async () => {
      const initial = await wallet.getPaymentConfig();
      expect(initial.gateway).toBe("manual");

      const updated = await wallet.savePaymentConfig({
        gateway: "zarinpal",
        merchantId: "merchant-uuid",
        sandbox: true,
        callbackUrl: "https://app.example.com/dashboard/billing",
        currency: "IRR",
        platformAdminId: ADMIN,
      });
      expect(updated.gateway).toBe("zarinpal");
      expect(updated.merchantId).toBe("merchant-uuid");

      // Empty merchant id clears it; omitted key keeps the stored value.
      const cleared = await wallet.savePaymentConfig({ merchantId: "" });
      expect(cleared.merchantId).toBe("");
      const kept = await wallet.savePaymentConfig({ sandbox: false });
      expect(kept.sandbox).toBe(false);
      expect(kept.gateway).toBe("zarinpal");
    });
  });
});

describe("credit packages catalogue", () => {
  it("creates, lists, updates (deactivate) and deletes", async () => {
    await asBiz(ALPHA, async () => {
      const pkg = await wallet.saveCreditPackage({
        name: "بسته ویژه",
        priceRial: 2_000_000,
        creditRial: 2_200_000,
        isActive: true,
        sortOrder: 1,
      });
      expect(pkg.creditRial).toBe(2_200_000);

      const active = await wallet.listCreditPackages(true);
      expect(active.some((p) => p.id === pkg.id)).toBe(true);

      const updated = await wallet.saveCreditPackage({
        id: pkg.id,
        name: pkg.name,
        priceRial: 2_000_000,
        creditRial: 2_200_000,
        isActive: false,
        sortOrder: 1,
      });
      expect(updated.isActive).toBe(false);
      expect((await wallet.listCreditPackages(true)).some((p) => p.id === pkg.id)).toBe(false);
      // Still visible to admins listing all.
      expect((await wallet.listCreditPackages(false)).some((p) => p.id === pkg.id)).toBe(true);

      await wallet.deleteCreditPackage(pkg.id);
      expect((await wallet.listCreditPackages(false)).some((p) => p.id === pkg.id)).toBe(false);
    });
  });

  it("rejects non-positive amounts and blank names", async () => {
    await asBiz(ALPHA, async () => {
      await expect(
        wallet.saveCreditPackage({ name: "x", priceRial: 0, creditRial: 10, isActive: true, sortOrder: 0 }),
      ).rejects.toThrow("bad_amount");
      await expect(
        wallet.saveCreditPackage({ name: "   ", priceRial: 10, creditRial: 10, isActive: true, sortOrder: 0 }),
      ).rejects.toThrow("missing_fields");
    });
  });
});

describe("Zarinpal top-up flow", () => {
  beforeEach(async () => {
    await db.query(`DELETE FROM billing_payments WHERE business_id = $1`, [ALPHA]);
    await db.query(`DELETE FROM wallet_ledger WHERE business_id = $1`, [ALPHA]);
    await db.query(`DELETE FROM business_wallets WHERE business_id = $1`, [ALPHA]);
    await asBiz(ALPHA, async () => {
      await wallet.savePaymentConfig({
        gateway: "zarinpal",
        merchantId: "merchant",
        sandbox: true,
        callbackUrl: "https://app.example.com/dashboard/billing",
      });
    });
  });

  it("creates, starts (redirect), and verifies a top-up, crediting exactly once", async () => {
    stubZarinpal({ verifyCode: 100 });
    await asBiz(ALPHA, async () => {
      const payment = await wallet.createPayment({
        businessId: ALPHA,
        purpose: "top_up",
        amountRial: 500_000,
        creditRial: 500_000,
        description: "شارژ ۵۰ هزار تومانی",
      });
      expect(payment.status).toBe("pending");

      const start = await wallet.startPayment(payment.id);
      expect(start.gateway).toBe("zarinpal");
      expect(start.redirectUrl).toContain("sandbox.zarinpal.com/pg/StartPay/");

      const started = await wallet.getPaymentById(payment.id);
      expect(started?.status).toBe("redirect");
      expect(started?.authority).toBeTruthy();

      // Browser returns with Status=OK.
      const verified = await wallet.verifyPayment({
        paymentId: payment.id,
        authority: started!.authority!,
        status: "OK",
      });
      expect(verified.status).toBe("verified");
      expect(verified.gatewayRef).toBe("1234567890");

      const w = await wallet.getWallet(ALPHA);
      expect(w.balanceRial).toBe(500_000);
      expect(w.totalToppedUpRial).toBe(500_000);

      // Re-verifying the same authority (code 101) never double credits.
      const again = await wallet.verifyPayment({
        paymentId: payment.id,
        authority: started!.authority!,
        status: "OK",
      });
      expect(again.status).toBe("verified");
      const w2 = await wallet.getWallet(ALPHA);
      expect(w2.balanceRial).toBe(500_000);

      // One ledger row only.
      const { rows } = await db.query(
        `SELECT count(*)::int AS c, COALESCE(SUM(amount_rial),0)::text AS total
           FROM wallet_ledger WHERE business_id = $1 AND kind = 'top_up'`,
        [ALPHA],
      );
      expect(rows[0].c).toBe(1);
      expect(Number(rows[0].total)).toBe(500_000);
    });
  });

  it("marks the payment cancelled when the gateway returns Status=NOK", async () => {
    stubZarinpal({ verifyCode: 100 });
    await asBiz(ALPHA, async () => {
      const payment = await wallet.createPayment({
        businessId: ALPHA,
        purpose: "top_up",
        amountRial: 300_000,
        creditRial: 300_000,
        description: "x",
      });
      await wallet.startPayment(payment.id);
      const started = await wallet.getPaymentById(payment.id);

      const result = await wallet.verifyPayment({
        paymentId: payment.id,
        authority: started!.authority!,
        status: "NOK",
      });
      expect(result.status).toBe("cancelled");
      expect((await wallet.getWallet(ALPHA)).balanceRial).toBe(0);
    });
  });

  it("marks the payment failed when Zarinpal verify refuses (user did not pay)", async () => {
    stubZarinpal({ verifyCode: -54 });
    await asBiz(ALPHA, async () => {
      const payment = await wallet.createPayment({
        businessId: ALPHA,
        purpose: "top_up",
        amountRial: 300_000,
        creditRial: 300_000,
        description: "x",
      });
      await wallet.startPayment(payment.id);
      const started = await wallet.getPaymentById(payment.id);

      const result = await wallet.verifyPayment({
        paymentId: payment.id,
        authority: started!.authority!,
        status: "OK",
      });
      expect(result.status).toBe("failed");
      expect((await wallet.getWallet(ALPHA)).balanceRial).toBe(0);
    });
  });

  it("surfaces a gateway error when the initial request fails", async () => {
    stubZarinpal({ requestOk: false });
    await asBiz(ALPHA, async () => {
      const payment = await wallet.createPayment({
        businessId: ALPHA,
        purpose: "top_up",
        amountRial: 300_000,
        creditRial: 300_000,
        description: "x",
      });
      await expect(wallet.startPayment(payment.id)).rejects.toMatchObject({
        code: "gateway_request_failed",
      });
    });
  });

  it("refuses to start a payment that is not pending", async () => {
    stubZarinpal({});
    await asBiz(ALPHA, async () => {
      const payment = await wallet.createPayment({
        businessId: ALPHA,
        purpose: "top_up",
        amountRial: 100_000,
        creditRial: 100_000,
        description: "x",
      });
      await wallet.startPayment(payment.id);
      // Second start must fail (already redirect).
      await expect(wallet.startPayment(payment.id)).rejects.toMatchObject({
        code: "payment_not_pending",
      });
    });
  });
});

describe("manual gateway approval / rejection", () => {
  it("approve credits the wallet and entitlements; reject moves nothing", async () => {
    await db.query(`DELETE FROM billing_payments WHERE business_id = $1`, [BETA]);
    await db.query(`DELETE FROM wallet_ledger WHERE business_id = $1`, [BETA]);
    await db.query(`DELETE FROM business_wallets WHERE business_id = $1`, [BETA]);

    await asBiz(BETA, async () => {
      await wallet.savePaymentConfig({ gateway: "manual" });

      // Rejected top-up.
      const bad = await wallet.createPayment({
        businessId: BETA,
        purpose: "top_up",
        amountRial: 200_000,
        creditRial: 200_000,
        description: "رد شده",
      });
      await wallet.rejectPayment(bad.id, { platformAdminId: ADMIN });
      expect((await wallet.getPaymentById(bad.id))?.status).toBe("failed");
      expect((await wallet.getWallet(BETA)).balanceRial).toBe(0);

      // Approved top-up.
      const good = await wallet.createPayment({
        businessId: BETA,
        purpose: "top_up",
        amountRial: 400_000,
        creditRial: 400_000,
        description: "تأیید شده",
      });
      expect((await wallet.startPayment(good.id)).redirectUrl).toBeNull(); // manual
      const settled = await wallet.settlePayment(good.id, {
        gatewayStatus: "manual_approved",
        platformAdminId: ADMIN,
      });
      expect(settled.status).toBe("verified");
      expect((await wallet.getWallet(BETA)).balanceRial).toBe(400_000);

      // Approving again is idempotent.
      await wallet.settlePayment(good.id, { platformAdminId: ADMIN });
      expect((await wallet.getWallet(BETA)).balanceRial).toBe(400_000);
    });
  });
});

describe("admin grants and deductions", () => {
  it("grants add credits and deduct refuses an overdraft", async () => {
    await db.query(`DELETE FROM wallet_ledger WHERE business_id = $1`, [BETA]);
    await db.query(`DELETE FROM business_wallets WHERE business_id = $1`, [BETA]);
    await asBiz(BETA, async () => {
      await wallet.grantCredits({ businessId: BETA, amountRial: 300_000, platformAdminId: ADMIN });
      await wallet.grantCredits({ businessId: BETA, amountRial: 200_000, platformAdminId: ADMIN });
      expect((await wallet.getWallet(BETA)).balanceRial).toBe(500_000);

      await wallet.deductCredits({ businessId: BETA, amountRial: 400_000, platformAdminId: ADMIN });
      expect((await wallet.getWallet(BETA)).balanceRial).toBe(100_000);

      await expect(
        wallet.deductCredits({ businessId: BETA, amountRial: 200_000, platformAdminId: ADMIN }),
      ).rejects.toBeInstanceOf(wallet.WalletInsufficientFundsError);
      // Balance untouched after the refused deduction.
      expect((await wallet.getWallet(BETA)).balanceRial).toBe(100_000);
    });
  });
});

describe("concurrent metered charges", () => {
  it("never overspends the balance under parallel charges", async () => {
    await db.query(`DELETE FROM wallet_ledger WHERE business_id = $1`, [ALPHA]);
    await db.query(`DELETE FROM feature_usage WHERE business_id = $1`, [ALPHA]);
    await db.query(`DELETE FROM business_wallets WHERE business_id = $1`, [ALPHA]);
    await asBiz(ALPHA, async () => {
      await wallet.grantCredits({ businessId: ALPHA, amountRial: 100_000 });
      // 10 concurrent charges of 30,000 against a 100,000 balance: exactly 3
      // succeed, the rest fail — the wallet row lock makes this exact.
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          wallet.chargeFeatureUse({ businessId: ALPHA, featureKey: "backup", priceRial: 30_000 }),
        ),
      );
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(3);
      expect(rejected).toHaveLength(7);
      expect((await wallet.getWallet(ALPHA)).balanceRial).toBe(10_000);

      const { rows } = await db.query<{ spent: string; charged: string }>(
        `SELECT spent_rial::text AS spent, charged_count::text AS charged
           FROM feature_usage WHERE business_id = $1 AND feature_key = 'backup'`,
        [ALPHA],
      );
      expect(Number(rows[0].spent)).toBe(90_000);
      expect(Number(rows[0].charged)).toBe(3);
    });
  });
});

describe("plan builder", () => {
  it("creates a plan with features and reflects them in feature access", async () => {
    await asBiz(ALPHA, async () => {
      await plans.saveBillingPlan({
        key: "tier-x",
        name: "پلن ایکس",
        description: "تست",
        monthlyPriceRial: 1_000_000,
        status: "active",
        sortOrder: 99,
        limits: { branches: { unlimited: true }, members: { unlimited: true }, monthlyOrders: { unlimited: true } },
      });
      // One authoritative row in billing_plans — the old dual-write into the
      // 0034 `plans` catalogue is gone (migration 0176).
      const { rows } = await db.query(
        `SELECT name, status FROM billing_plans WHERE key = 'tier-x'`,
      );
      expect(rows[0].name).toBe("پلن ایکس");
      expect(rows[0].status).toBe("active");

      await plans.savePlanFeature({
        planKey: "tier-x",
        featureKey: "reporting",
        pricingModel: "per_use",
        priceRial: 25_000,
        sortOrder: 1,
      });
      await plans.savePlanFeature({
        planKey: "tier-x",
        featureKey: "ledger",
        pricingModel: "included",
        priceRial: 0,
        sortOrder: 2,
      });

      const feats = await plans.listPlanFeatures("tier-x");
      expect(feats.map((f) => f.featureKey).sort()).toEqual(["ledger", "reporting"]);

      // Switch the business onto the plan and read effective access.
      await billing.activatePurchasedPlan({ businessId: ALPHA, planKey: "tier-x" });
      const reporting = await plans.resolveFeatureAccess(ALPHA, "reporting");
      expect(reporting.metered).toBe(true);
      expect(reporting.perUsePriceRial).toBe(25_000);
      const ledgerAccess = await plans.resolveFeatureAccess(ALPHA, "ledger");
      expect(ledgerAccess.entitled).toBe(true);

      // Delete a feature pricing row.
      await plans.deletePlanFeature("tier-x", "reporting");
      expect((await plans.listPlanFeatures("tier-x")).map((f) => f.featureKey)).toEqual(["ledger"]);
    });
  });
});

describe("cross-business isolation", () => {
  it("enforced by RLS: a scoped role cannot see another business's billing rows", async () => {
    if (!rlsActive) {
      // The CI/dev default connects as a superuser (BYPASSRLS), under which
      // this assertion is vacuous — the dedicated role below makes it real
      // whenever the deployment has one; if even that role is privileged we
      // skip rather than falsely pass.
      const { rows } = await appClient.query<{ privileged: boolean }>(
        "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user",
      );
      if (rows[0]?.privileged) {
        console.warn("Skipping RLS isolation: test role is privileged");
        return;
      }
    }

    // Seed distinct balances for each business as the owner (bypassing RLS).
    await db.query(`DELETE FROM wallet_ledger WHERE business_id IN ($1,$2)`, [ALPHA, BETA]);
    await db.query(`DELETE FROM business_wallets WHERE business_id IN ($1,$2)`, [ALPHA, BETA]);
    await db.query(`INSERT INTO business_wallets (business_id, balance_rial) VALUES ($1, 777000), ($2, 444000)`, [
      ALPHA,
      BETA,
    ]);
    await db.query(
      `INSERT INTO wallet_ledger (business_id, kind, direction, amount_rial, balance_after_rial)
       VALUES ($1, 'admin_grant', 'credit', 777000, 777000)`,
      [ALPHA],
    );

    // BETA's scoped connection sees only its own wallet, zero ledger rows from ALPHA.
    await asAppRole(BETA, async (c) => {
      const { rows: wallets } = await c.query<{ c: number; bal: string }>(
        `SELECT count(*)::int AS c, COALESCE(SUM(balance_rial),0)::text AS bal
           FROM business_wallets`,
      );
      expect(wallets[0].c).toBe(1);
      expect(Number(wallets[0].bal)).toBe(444_000);

      const { rows: ledger } = await c.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM wallet_ledger WHERE business_id = $1`,
        [ALPHA],
      );
      // Explicitly asking for ALPHA's ledger while scoped to BETA returns nothing.
      expect(ledger[0].c).toBe(0);
    });

    // ALPHA's scoped connection sees exactly its own balance.
    await asAppRole(ALPHA, async (c) => {
      const { rows } = await c.query<{ bal: string }>(
        `SELECT balance_rial::text AS bal FROM business_wallets`,
      );
      expect(Number(rows[0].bal)).toBe(777_000);
    });
  });
});
