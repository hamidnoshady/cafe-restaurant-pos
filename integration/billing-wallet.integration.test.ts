/**
 * Platform billing — wallet credits, plan-builder pricing, free-for-time /
 * free-for-use promotions, per-use charges, and payment settlement.
 *
 * Runs the full billing service surface against a real migrated database,
 * inside `withTenant` (the RLS scope every API route establishes) because the
 * business-owned tables are FORCE-RLS protected (migration 0130).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;

let wallet: typeof import("../src/lib/wallet-service");
let plans: typeof import("../src/lib/billing-plans-service");
let billing: typeof import("../src/lib/billing-service");
let dbLib: typeof import("../src/lib/db");

const BID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_billing_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);

  wallet = await import("../src/lib/wallet-service");
  plans = await import("../src/lib/billing-plans-service");
  billing = await import("../src/lib/billing-service");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  await db.query(
    `INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'کافه تست', 'test-cafe', 'pro')`,
    [BID],
  );
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
});

/** Run every service call the same scope the API routes establish. */
function scoped<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(BID, fn);
}

describe("wallet credits", () => {
  it("grants, charges and refuses overdraft with row-locked ledger", async () => {
    await scoped(async () => {
      const g = await wallet.grantCredits({ businessId: BID, amountRial: 1_000_000, note: "شارز اولیه" });
      expect(g.balanceRial).toBe(1_000_000);

      // An unpriced function is not metered: free and no ledger charge.
      const free = await billing.billFeatureUse({ businessId: BID, featureKey: "ledger" });
      expect(free.charged).toBe(false);
      expect(free.priceRial).toBe(0);

      const ledgerAfterFree = await wallet.listLedger(BID);
      expect(ledgerAfterFree.some((e) => e.kind === "feature_charge")).toBe(false);

      // Charge more than the balance → dedicated error, balance untouched.
      await expect(
        wallet.chargeFeatureUse({ businessId: BID, featureKey: "backup", priceRial: 5_000_000 }),
      ).rejects.toBeInstanceOf(wallet.WalletInsufficientFundsError);

      const after = await wallet.getWallet(BID);
      expect(after.balanceRial).toBe(1_000_000);
      expect(after.totalSpentRial).toBe(0);
    });
  });
});

describe("plan builder pricing + promotions", () => {
  it("free-for-N-uses promo counts down, then bills per use", async () => {
    await scoped(async () => {
      // Fresh usage counters so the quota starts at zero regardless of order.
      await db.query(`DELETE FROM feature_usage WHERE business_id = $1 AND feature_key = 'backup'`, [BID]);
      await plans.savePlanFeature({
        planKey: "pro",
        featureKey: "backup",
        pricingModel: "per_use",
        priceRial: 50_000,
        freeLimit: 2,
        sortOrder: 1,
      });

      const a0 = await plans.resolveFeatureAccess(BID, "backup");
      expect(a0.entitled).toBe(true);
      expect(a0.metered).toBe(true);
      expect(a0.promoActive).toBe(true);
      expect(a0.perUsePriceRial).toBe(0);
      expect(a0.freeUsesRemaining).toBe(2);

      // First two uses free (but counted toward the quota).
      const u1 = await billing.billFeatureUse({ businessId: BID, featureKey: "backup" });
      expect(u1.charged).toBe(false);
      const u2 = await billing.billFeatureUse({ businessId: BID, featureKey: "backup" });
      expect(u2.charged).toBe(false);

      const a1 = await plans.resolveFeatureAccess(BID, "backup");
      expect(a1.promoActive).toBe(false);
      expect(a1.perUsePriceRial).toBe(50_000);

      // Third use is charged from the wallet.
      const u3 = await billing.billFeatureUse({ businessId: BID, featureKey: "backup" });
      expect(u3.charged).toBe(true);
      expect(u3.priceRial).toBe(50_000);

      const w = await wallet.getWallet(BID);
      expect(w.balanceRial).toBe(950_000);
      expect(w.totalSpentRial).toBe(50_000);
    });
  });

  it("free-for-time promo is active until its date and paid afterwards", async () => {
    await scoped(async () => {
      const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      await plans.savePlanFeature({
        planKey: "pro",
        featureKey: "ai_assistant",
        pricingModel: "per_use",
        priceRial: 100_000,
        freeUntil: future,
        sortOrder: 2,
      });

      const now = await plans.resolveFeatureAccess(BID, "ai_assistant");
      expect(now.promoActive).toBe(true);
      expect(now.perUsePriceRial).toBe(0);

      // After the window → the normal price applies.
      const past = new Date(Date.now() + 8 * 24 * 3600 * 1000);
      const later = await plans.resolveFeatureAccess(BID, "ai_assistant", past);
      expect(later.promoActive).toBe(false);
      expect(later.perUsePriceRial).toBe(100_000);
    });
  });

  it("addon feature is locked until purchased/granted", async () => {
    await scoped(async () => {
      await plans.savePlanFeature({
        planKey: "pro",
        featureKey: "integrations",
        pricingModel: "addon",
        priceRial: 200_000,
        sortOrder: 3,
      });
      const before = await plans.resolveFeatureAccess(BID, "integrations");
      expect(before.entitled).toBe(false);
      await expect(
        billing.billFeatureUse({ businessId: BID, featureKey: "integrations" }),
      ).rejects.toBeInstanceOf(billing.FeatureNotEntitledError);

      await billing.fulfilPurchasedEntitlement({
        businessId: BID,
        featureKey: "integrations",
        source: "addon",
      });
      const after = await plans.resolveFeatureAccess(BID, "integrations");
      expect(after.entitled).toBe(true);
    });
  });
});

describe("payment settlement", () => {
  it("settles a manual top-up exactly once, crediting the wallet", async () => {
    await scoped(async () => {
      const before = await wallet.getWallet(BID);
      const pay = await wallet.createPayment({
        businessId: BID,
        purpose: "top_up",
        amountRial: 500_000,
        creditRial: 500_000,
        description: "تست شارژ",
      });
      expect(pay.status).toBe("pending");

      const settled = await wallet.settlePayment(pay.id, { gatewayStatus: "manual_approved" });
      expect(settled.status).toBe("verified");

      // Idempotent: a duplicate settlement must not double-credit.
      const again = await wallet.settlePayment(pay.id);
      expect(again.status).toBe("verified");

      const after = await wallet.getWallet(BID);
      expect(after.balanceRial).toBe(before.balanceRial + 500_000);
      expect(after.totalToppedUpRial).toBe(before.totalToppedUpRial + 500_000);

      // Exactly one top_up ledger row references the payment.
      const { rows } = await db.query(
        `SELECT count(*)::int AS c FROM wallet_ledger WHERE payment_id = $1`,
        [pay.id],
      );
      expect(rows[0].c).toBe(1);
    });
  });

  it("a verified plan purchase moves the business onto that plan", async () => {
    await scoped(async () => {
      // Build a purchasable plan with a monthly fee.
      await plans.saveBillingPlan({
        key: "gold",
        name: "پلن طلایی",
        monthlyPriceRial: 900_000,
        status: "active",
        sortOrder: 40,
        limits: { branches: { unlimited: true }, members: { unlimited: true }, monthlyOrders: { unlimited: true } },
      });
      const pay = await wallet.createPayment({
        businessId: BID,
        purpose: "plan_purchase",
        amountRial: 900_000,
        planKey: "gold",
        description: "اشتراک پلن طلایی",
      });
      await wallet.settlePayment(pay.id);
      await billing.activatePurchasedPlan({ businessId: BID, planKey: "gold" });

      const { rows } = await db.query(`SELECT plan FROM businesses WHERE id = $1`, [BID]);
      expect(rows[0].plan).toBe("gold");
    });
  });
});
